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
    if (el.innerHTML.replace(/\u200b/g, '') === probe.innerHTML) return;
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
        return escapeHtml(part).replace(/\n/g, '<br>');
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
    const startNode = range.startContainer;
    const startOffset = range.startOffset;
    let offset = 0;
    let done = false;

    const walk = (node: Node) => {
      if (done) return;
      if (node === startNode) {
        if (node.nodeType === Node.TEXT_NODE) {
          const t = (node.textContent || '').replace(/\u00a0/g, ' ').replace(/\u200b/g, '');
          offset += Math.min(startOffset, t.length);
        } else {
          const children = Array.from(node.childNodes);
          for (let i = 0; i < Math.min(startOffset, children.length); i++) {
            domWalk(children[i], (t) => (offset += t.length));
          }
        }
        done = true;
        return;
      }
      domWalk(node, (t) => (offset += t.length));
    };
    promptEditor.childNodes.forEach(walk);
    return done ? offset : -1;
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
        if (remaining <= 1) {
          target = { node, off: 0, mode: 'before' };
          return true;
        }
        remaining -= 1;
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

  function onEditorInput() {
    prompt = editorToPrompt();
    promptCursor = getEditorCaretOffset();
    // Live-render: if the user typed a token, turn it into a badge. Skipped
    // during IME composition — re-rendering would break the composition.
    if (!composing) renderPromptEditor();
  }

  /** Insert a single <br> at the caret with the caret placed AFTER it, then
   *  re-sync the prompt. (execCommand insertHTML/insertLineBreak in this
   *  Chromium misplace the caret or insert double breaks.)
   *
   *  Chromium quirk: a caret placed after a *trailing* <br> is normalized back
   *  before it, so the next keystroke lands on the previous line (requiring a
   *  second Enter to "create" the new line). We anchor the caret with an
   *  invisible zero-width space after a trailing break; the anchor is stripped
   *  everywhere (domWalk / getEditorCaretOffset / renderPromptEditor) and gets
   *  consumed naturally by the next keystroke. */
  function insertLineBreakAtCaret() {
    if (!promptEditor) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const br = document.createElement('br');
    range.insertNode(br);
    // Is the br trailing (nothing meaningful after it)? Only then anchor.
    let trailing = true;
    for (let s = br.nextSibling; s; s = s.nextSibling) {
      const meaningful =
        s.nodeType === Node.TEXT_NODE
          ? (s.textContent || '').replace(/\u200b/g, '') !== ''
          : s.nodeType === Node.ELEMENT_NODE && (s as HTMLElement).tagName !== 'BR';
      if (meaningful) { trailing = false; break; }
    }
    let anchor: Text | null = null;
    if (trailing) {
      anchor = document.createTextNode('\u200b');
      br.parentNode?.insertBefore(anchor, br.nextSibling);
    }
    const after = document.createRange();
    if (anchor) {
      after.setStart(anchor, 1); // after the zero-width space
    } else {
      after.setStartAfter(br);
    }
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
           inserted badge. -->
      <details class="dropdown dropdown-end">
        <summary
          class="btn btn-xs btn-outline btn-circle"
          aria-label={$_("review.ref2v.addReference")}
          on:mousedown|preventDefault
        >+</summary>
        <ul
          class="menu dropdown-content bg-base-200 rounded-box z-10 w-56 max-h-64 overflow-y-auto p-1 shadow"
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
      // Normalize pasted text (strip HTML so tokens stay plain text,
      // and convert newlines to <br> so the DOM stays text+br+badges)
      e.preventDefault();
      const text = e.clipboardData?.getData('text/plain') || '';
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (i > 0) insertLineBreakAtCaret();
        if (line) document.execCommand('insertText', false, line);
      });
      onEditorInput();
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
</div>
