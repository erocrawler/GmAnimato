<script lang="ts">
  // Ref2V-aware prompt editor: a contenteditable that renders <Picture N> /
  // <Video 1> tokens as inline badge chips, with a "+" picker to insert refs
  // at the cursor. Refs may be used multiple times.
  import { _ } from "svelte-i18n";

  export let prompt: string = "";
  export let isEditable: boolean = true;
  export let videoWorkflowType: string = "";
  export let promptRelayMode: boolean = false;
  export let refItems: { kind: "video" | "image"; token: string; url: string; label: string }[] = [];
  export let referencedTokens: string[] = [];
  export let availableRefs: { kind: "video" | "image"; token: string; url: string; label: string }[] = [];

  let promptEditor: HTMLDivElement | undefined;
  let promptCursor = -1;
  // Ref picker <details> — closed programmatically after inserting a token,
  // mirroring the ref2v preset dropdown behavior.
  let refPickerEl: HTMLDetailsElement | undefined;
  function closeRefPicker() {
    if (refPickerEl) refPickerEl.removeAttribute("open");
  }
  // True while an IME composition (e.g. Chinese input) is in progress — we skip
  // re-rendering the editor during composition or the IME breaks.
  let composing = false;

  /** Render the prompt text into the contenteditable, tokenizing <Picture N> /
   *  <Video 1> into badge spans. Preserves cursor where possible. Skips the
   *  rebuild when nothing changed structurally (plain typing keeps native
   *  editing + undo). Zero-width caret anchors are ignored in the comparison,
   *  and the regenerated HTML is parsed by the browser first so self-closing
   *  <img /> / attribute forms serialize identically on both sides. */
  function renderPromptEditor() {
    if (!promptEditor) return;
    const el = promptEditor;
    const html = tokenizePrompt(prompt);
    const probe = document.createElement('div');
    probe.innerHTML = html;
    // Compare with ZWSP stripped on BOTH sides: ZWSPs are caret anchors (after
    // <br> and after trailing breaks) and must never trigger a rebuild.
    if (el.innerHTML.replace(/\u200b/g, '') === probe.innerHTML.replace(/\u200b/g, '')) return;

    // Safety net: if the prompt is empty/whitespace but the editor still has
    // meaningful content, the `prompt` variable is stale — e.g. a racing
    // external update (Svelte 5 bind + parent re-render) or a transient empty
    // read. Re-derive it from the DOM instead of wiping the user's work.
    const domText = (el.textContent || '').replace(/\u200b/g, '').trim();
    if (!prompt.trim() && domText) {
      const fresh = editorToPrompt();
      if (fresh.trim()) {
        prompt = fresh;
        return;
      }
    }

    // Save caret position as character offset into the plain text
    const caretOffset = getEditorCaretOffset();
    el.innerHTML = html;
    restoreEditorCaret(caretOffset);
  }

  function tokenizePrompt(text: string): string {
    // Split on tokens, wrap each in a badge span. The badge's visible text is
    // exactly the token (escaped), so DOM text length == source prompt length
    // and caret offsets computed via the DOM walkers stay consistent.
    const parts = text.split(/(<(?:Picture|Video)\s*\d+>)/g);
    return parts
      .map((part) => {
        const m = part.match(/^<(Picture|Video)\s*(\d+)>$/);
        if (m) {
          const kind = m[1].toLowerCase();
          const num = m[2];
          const ref = refItems.find((r) => r.token === part);
          const thumb = ref?.kind === 'image'
            ? `<img src="${ref.url}" alt="" class="w-3.5 h-3.5 rounded object-cover inline-block align-middle" />`
            : '';
          const icon = ref?.kind === 'video'
            ? '<svg class="w-3.5 h-3.5 inline-block align-middle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="m10 9 5 3-5 3z"/></svg>'
            : '';
          return `<span class="inline-flex items-center gap-1 badge badge-primary badge-sm font-normal px-1.5 py-0.5 align-middle" contenteditable="false" data-ref-token="${escapeHtml(part)}">${thumb}${icon}<span>${escapeHtml(part)}</span></span>`;
        }
        return escapeHtml(part).replace(/\n/g, '<br>\u200b');
      })
      .join("");
  }

  function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /** Walk a node, appending its "source prompt" text: text nodes verbatim
   *  (zero-width caret anchors stripped), <br> as "\n", badges as their
   *  token, icons skipped. Used by both editorToPrompt and
   *  getEditorCaretOffset so they can never disagree. */
  function domWalk(node: Node, onText: (t: string) => void): void {
    if (node.nodeType === Node.TEXT_NODE) {
      onText((node.textContent || '').replace(/\u00a0/g, ' ').replace(/\u200b/g, ''));
      return;
    }
    const el = node as HTMLElement;
    const tag = el.tagName;
    if (tag === 'BR') {
      onText('\n');
      return;
    }
    if (tag === 'IMG' || tag === 'SVG') return; // decorative icons
    if (el.hasAttribute('data-ref-token')) {
      onText(el.getAttribute('data-ref-token') || '');
      return;
    }
    el.childNodes.forEach((c) => domWalk(c, onText));
  }

  function editorToPrompt(): string {
    if (!promptEditor) return prompt;
    let out = '';
    promptEditor.childNodes.forEach((c) => domWalk(c, (t) => (out += t)));
    return out;
  }

  function getEditorCaretOffset(): number {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !promptEditor) return -1;
    const range = sel.getRangeAt(0);
    return offsetInEditor(range.startContainer, range.startOffset);
  }

  /** Character offset of (node, offset) within the editor's prompt text — the
   *  same walk getEditorCaretOffset uses, parameterized over an arbitrary
   *  node/offset (e.g. both ends of a non-collapsed selection). Returns -1
   *  when the node isn't inside the editor. */
  function offsetInEditor(node: Node, offset: number): number {
    if (!promptEditor) return -1;
    let pos = 0;
    let done = false;
    const walk = (n: Node) => {
      if (done) return;
      if (n === node) {
        if (n.nodeType === Node.TEXT_NODE) {
          const t = (n.textContent || '').replace(/\u00a0/g, ' ').replace(/\u200b/g, '');
          pos += Math.min(offset, t.length);
        } else {
          const children = Array.from(n.childNodes);
          for (let i = 0; i < Math.min(offset, children.length); i++) {
            domWalk(children[i], (t) => (pos += t.length));
          }
        }
        done = true;
        return;
      }
      domWalk(n, (t) => (pos += t.length));
    };
    promptEditor.childNodes.forEach(walk);
    return done ? pos : -1;
  }

  function restoreEditorCaret(offset: number) {
    if (offset < 0 || !promptEditor) return;
    const sel = window.getSelection();
    if (!sel) return;
    let remaining = offset;
    let target: { node: Node; off: number; mode: 'in' | 'before' | 'after' } | null = null;

    const walk = (node: Node): boolean => {
      if (target) return true;
      if (node.nodeType === Node.TEXT_NODE) {
        const raw = node.textContent || '';
        const stripped = raw.replace(/\u200b/g, '');
        if (stripped.length === 0) return false; // ZWSP caret-anchor node: invisible, skip
        if (remaining <= stripped.length) {
          // Map the stripped-space offset back to a raw offset in the node.
          let rawOff = 0;
          let seen = 0;
          for (let i = 0; i < raw.length; i++) {
            if (raw[i] === '\u200b') { rawOff++; continue; }
            if (seen === remaining) break;
            seen++; rawOff++;
          }
          target = { node, off: rawOff, mode: 'in' };
          return true;
        }
        remaining -= stripped.length;
        return false;
      }
      const el = node as HTMLElement;
      const tag = el.tagName;
      if (tag === 'BR') {
        if (remaining <= 0) {
          target = { node, off: 0, mode: 'before' };
          return true;
        }
        remaining -= 1;
        if (remaining <= 0) {
          // Consumed the newline: caret goes to the start of the next line.
          // Anchor it inside the ZWSP text node that follows the <br> (it's a
          // caret home so backspace deletes the <br>, not an adjacent badge).
          // If the break is trailing, sit AFTER the ZWSP so Chromium doesn't
          // normalize the caret back before the <br>.
          const next = el.nextSibling;
          if (next && next.nodeType === Node.TEXT_NODE && (next.textContent || '').replace(/\u200b/g, '') === '') {
            let trailing = true;
            for (let s = next.nextSibling; s; s = s.nextSibling) {
              const meaningful =
                s.nodeType === Node.TEXT_NODE
                  ? (s.textContent || '').replace(/\u200b/g, '') !== ''
                  : s.nodeType === Node.ELEMENT_NODE && (s as HTMLElement).tagName !== 'BR';
              if (meaningful) { trailing = false; break; }
            }
            target = { node: next, off: trailing ? 1 : 0, mode: 'in' };
          } else if (next && next.nodeType === Node.TEXT_NODE) {
            target = { node: next, off: 0, mode: 'in' };
          } else {
            target = { node: el, off: 0, mode: 'after' };
          }
          return true;
        }
        return false;
      }
      if (tag === 'IMG' || tag === 'SVG') return false;
      if (el.hasAttribute('data-ref-token')) {
        const tok = el.getAttribute('data-ref-token') || '';
        if (remaining <= tok.length) {
          target = { node: el, off: 0, mode: remaining === tok.length ? 'after' : 'before' };
          return true;
        }
        remaining -= tok.length;
        return false;
      }
      for (const c of Array.from(el.childNodes)) {
        if (walk(c)) return true;
      }
      return false;
    };

    for (const c of Array.from(promptEditor.childNodes)) {
      if (walk(c)) break;
    }

    const range = document.createRange();
    if (!target) {
      range.selectNodeContents(promptEditor);
      range.collapse(false);
    } else {
      const t = target as { node: Node; off: number; mode: 'in' | 'before' | 'after' };
      if (t.mode === 'in') {
        const text = t.node.textContent || '';
        range.setStart(t.node, Math.min(t.off, text.length));
        range.collapse(true);
      } else if (t.mode === 'before') {
        range.setStartBefore(t.node);
        range.collapse(true);
      } else {
        range.setStartAfter(t.node);
        range.collapse(true);
      }
    }
    sel.removeAllRanges();
    sel.addRange(range);
  }

  const MAX_PROMPT_CHARS = 10000; // matches DB VarChar(10000)

  function onEditorInput() {
    let next = editorToPrompt();
    // Anti-wipe guard: if the DOM walk returns empty BUT the visible DOM still
    // has content, the walk hit a transient state (renderPromptEditor sets
    // el.innerHTML, and an input event can fire in that window; or a
    // caret/selection edge case) — NOT the user deleting everything (a real
    // clear leaves the DOM empty too). Re-sync from the last known-good prompt
    // instead of letting the empty read wipe the user's essay.
    const domHasContent =
      !!promptEditor &&
      (promptEditor.textContent || "").replace(/\u200b/g, "").trim() !== "";
    if (next.trim() === "" && domHasContent && !composing) {
      renderPromptEditor();
      return;
    }
    // Hard cap at the DB column limit: pasting/typing past MAX_PROMPT_CHARS
    // would make the server 500 on write. Trim to the limit (never silently
    // drop the whole prompt — the user's text is preserved up to the cap).
    if (next.length > MAX_PROMPT_CHARS) {
      next = next.slice(0, MAX_PROMPT_CHARS);
      prompt = next;
      promptCursor = getEditorCaretOffset();
      renderPromptEditor();
      promptEditor?.focus();
      restoreEditorCaret(prompt.length);
      return;
    }
    prompt = next;
    promptCursor = getEditorCaretOffset();
    // Live-render: if the user typed a token, turn it into a badge. Skipped
    // during IME composition — re-rendering would break the composition.
    if (!composing) renderPromptEditor();
  }

  /** Insert a single <br> at the caret, always followed by a zero-width-space
   *  caret anchor, then re-sync the prompt.
   *
   *  The ZWSP gives the caret a text home after the break:
   *  - a caret directly after a *trailing* <br> is normalized back before it
   *    by Chromium (requiring a second Enter), so we sit AFTER the anchor;
   *  - a caret at a bare <br>/badge boundary makes Backspace delete the badge
   *    instead of the break, so the anchor gives Backspace something to chew
   *    through first.
   *  The anchor is stripped everywhere (domWalk / getEditorCaretOffset /
   *  renderPromptEditor comparison) and consumed naturally by the next
   *  keystroke. */
  function insertLineBreakAtCaret() {
    if (!promptEditor) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const br = document.createElement('br');
    range.insertNode(br);
    // Is the br trailing (nothing meaningful after it)? The caret then sits
    // AFTER the anchor; otherwise BEFORE it (so Backspace removes the <br>).
    let trailing = true;
    for (let s = br.nextSibling; s; s = s.nextSibling) {
      const meaningful =
        s.nodeType === Node.TEXT_NODE
          ? (s.textContent || '').replace(/\u200b/g, '') !== ''
          : s.nodeType === Node.ELEMENT_NODE && (s as HTMLElement).tagName !== 'BR';
      if (meaningful) { trailing = false; break; }
    }
    const anchor = document.createTextNode('\u200b');
    br.parentNode?.insertBefore(anchor, br.nextSibling);
    const after = document.createRange();
    after.setStart(anchor, trailing ? 1 : 0);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
    onEditorInput();
  }

  function insertRefToken(token: string) {
    if (!isEditable) return;
    if (!promptEditor) {
      prompt = (prompt.trim() + " " + token).trim();
      return;
    }
    // Prefer the live caret when the selection is still inside the editor (it
    // persists after clicking the + button); fall back to the last tracked
    // promptCursor position.
    const sel = window.getSelection();
    const liveCaret =
      sel && sel.rangeCount > 0 && promptEditor.contains(sel.getRangeAt(0).startContainer)
        ? getEditorCaretOffset()
        : -1;
    let caretOffset = liveCaret >= 0 ? liveCaret : promptCursor;
    if (caretOffset < 0 || caretOffset > prompt.length) caretOffset = prompt.length;
    const before = prompt.slice(0, caretOffset);
    const after = prompt.slice(caretOffset);
    const sepBefore = before && !/\s$/.test(before) ? " " : "";
    const sepAfter = after && !/^\s/.test(after) ? " " : "";
    prompt = before + sepBefore + token + sepAfter + after;
    promptCursor = (before + sepBefore + token).length;
    renderPromptEditor();
    // renderPromptEditor restores the *old* caret (it re-reads the DOM before
    // the rebuild). Then focus the editor FIRST and place the caret after the
    // inserted badge LAST: if the editor lost focus (user clicked the + button
    // and a picker item), .focus() would restore the browser's stored pre-blur
    // caret and clobber the placement otherwise.
    promptEditor.focus();
    restoreEditorCaret(promptCursor);
    closeRefPicker();
  }

  function insertAllRefTokens() {
    if (!isEditable || availableRefs.length === 0) return;
    // Append every not-yet-referenced token at the end of the prompt (separated
    // by a space), so a user can quickly make all refs explicit.
    const suffix = availableRefs.map((r) => r.token).join(" ");
    prompt = (prompt.trim() + " " + suffix).trim();
    renderPromptEditor();
    // Focus first, then place the caret at the end (see insertRefToken).
    if (promptEditor) promptEditor.focus();
    restoreEditorCaret(prompt.length);
    closeRefPicker();
  }

  // Re-render when the prompt changes externally (suggestion click, relay AI,
  // entry sync) — but skip when the DOM already matches (user typing).
  // `prompt` is referenced textually so Svelte tracks it as a dependency.
  $: promptEditor && (prompt, renderPromptEditor());
</script>

<div class="form-control">
  <label class="label pb-1" for="prompt">
    <span class="label-text text-sm font-medium">
      {promptRelayMode
        ? $_("review.relay.globalPrompt")
        : $_("review.yourPrompt")}
    </span>
  </label>

  {#if videoWorkflowType === "ref2v" && refItems.length > 0}
    <!-- Ref2V reference editor: tokens render as inline badges, and a "+"
         button opens a picker of all refs (referenced or not) to insert at
         the cursor. Refs may be used multiple times. -->
    <div class="flex flex-wrap items-center gap-2 mb-2">
      <span class="text-xs opacity-70">{$_("review.ref2v.referencesLabel")}</span>

      <!-- "+" button opens the picker of all refs. mousedown|preventDefault
           keeps focus in the prompt editor so the browser never stores a
           pre-blur selection that would later restore the caret before the
           inserted badge. Styled to match the ref2v preset dropdown. -->
      <details bind:this={refPickerEl} class="dropdown dropdown-end">
        <summary
          class="btn btn-sm btn-outline gap-1.5"
          aria-label={$_("review.ref2v.addReference")}
          on:mousedown|preventDefault
        >
          <span class="flex items-center gap-1.5">
            <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
            <span>{$_("review.ref2v.addReference")}</span>
            <span class="badge badge-xs badge-ghost">{refItems.length}</span>
          </span>
          <span class="flex items-center gap-2">
            <svg class="w-3 h-3 opacity-60" viewBox="0 0 20 20" fill="currentColor"><path d="M5.5 7l4.5 4 4.5-4z" /></svg>
          </span>
        </summary>
        <ul
          class="menu dropdown-content bg-base-200 rounded-box z-20 w-64 max-h-[28rem] overflow-y-auto p-2 shadow-lg mt-1"
        >
          {#if availableRefs.length > 1}
            <li>
              <button
                type="button"
                class="flex items-center gap-2 text-xs font-semibold"
                on:mousedown|preventDefault
                on:click={() => { insertAllRefTokens(); }}
              >
                <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
                {$_("review.ref2v.addAllReferences")}
              </button>
            </li>
            <li class="menu-title"><span class="text-xs opacity-50">{$_("review.ref2v.referencesLabel")}</span></li>
          {/if}
          {#each refItems as ref (ref.token)}
            <li>
              <button
                type="button"
                class="flex items-center gap-2 text-sm"
                on:mousedown|preventDefault
                on:click={() => { insertRefToken(ref.token); }}
              >
                {#if referencedTokens.includes(ref.token)}
                  <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-success shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                {/if}
                {#if ref.kind === "video"}
                  <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="m10 9 5 3-5 3z"/></svg>
                {:else}
                  <img src={ref.url} alt={ref.label} class="w-8 h-8 rounded object-cover shrink-0" />
                {/if}
                <span>{ref.label}</span>
              </button>
            </li>
          {/each}
        </ul>
      </details>

      {#if availableRefs.length > 0}
        <span class="text-xs text-warning">
          {$_("review.ref2v.unreferencedHint", { values: { count: availableRefs.length } })}
        </span>
      {:else}
        <span class="text-xs text-success">{$_("review.ref2v.allReferencesUsedShort")}</span>
      {/if}
      <span class="text-xs opacity-50">{$_("review.ref2v.referencesHint")}</span>
    </div>
  {/if}

  <div
    id="prompt"
    contenteditable={isEditable}
    tabindex="0"
    class="textarea textarea-bordered textarea-lg min-h-32 w-full whitespace-pre-wrap"
    role="textbox"
    aria-multiline="true"
    aria-label={$_("review.yourPrompt")}
    bind:this={promptEditor}
    on:input={onEditorInput}
    on:keyup={() => (promptCursor = getEditorCaretOffset())}
    on:click={() => (promptCursor = getEditorCaretOffset())}
    on:focus={() => (promptCursor = getEditorCaretOffset())}
    on:compositionstart={() => (composing = true)}
    on:compositionend={() => {
      composing = false;
      onEditorInput();
    }}
    on:paste={(e) => {
      // Paste as plain text at the caret. String-splice + re-render (the same
      // proven path as insertRefToken) instead of the deprecated
      // document.execCommand('insertText'), which — when the DOM selection is
      // missing or stale (e.g. after an external prompt update) — inserts at
      // the START of the editor instead of the caret. Falls back to the last
      // tracked caret position when there is no live selection inside the
      // editor.
      e.preventDefault();
      const text = e.clipboardData?.getData('text/plain') || '';
      if (!text || !isEditable) return;

      // Resolve the insertion point: live selection inside the editor first
      // (handles replacing a selected range), then the tracked caret, then the
      // end of the prompt.
      let start = -1;
      let end = -1;
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && promptEditor?.contains(sel.getRangeAt(0).startContainer)) {
        const range = sel.getRangeAt(0);
        start = offsetInEditor(range.startContainer, range.startOffset);
        end = range.collapsed ? start : offsetInEditor(range.endContainer, range.endOffset);
      }
      if (start < 0 || start > prompt.length) {
        start = promptCursor >= 0 && promptCursor <= prompt.length ? promptCursor : prompt.length;
        end = start;
      }
      if (end < start) end = start;

      prompt = prompt.slice(0, start) + text + prompt.slice(end);
      promptCursor = start + text.length;
      renderPromptEditor();
      promptEditor?.focus();
      restoreEditorCaret(promptCursor);
    }}
    on:keydown={(e) => {
      // Enter must insert a single bare <br> (with the caret after it)
      // instead of the browser's default <div> block, so the DOM stays
      // text+br+badges and the DOM walker stays exact.
      if (e.key === 'Enter' && isEditable) {
        e.preventDefault();
        insertLineBreakAtCaret();
      }
    }}
  ></div>

  <div class="flex justify-end mt-1">
    <span
      class="text-xs"
      class:opacity-40={prompt.length < MAX_PROMPT_CHARS}
      class:text-warning={prompt.length >= MAX_PROMPT_CHARS}
    >
      {prompt.length}/{MAX_PROMPT_CHARS}
    </span>
  </div>
</div>
