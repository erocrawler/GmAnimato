<script lang="ts">
  // Ref2V-aware prompt editor built on TipTap (ProseMirror). <Picture N> /
  // <Video 1> tokens render as inline badge chips via a custom atom node
  // ("referenceToken"); the editor's plain text IS the prompt — every badge
  // serializes back to its literal token, so getText() round-trips losslessly
  // with no DOM walkers or caret arithmetic of our own. ProseMirror owns
  // caret placement, IME composition, paste, and undo/redo.
  import { _ } from "svelte-i18n";
  import { onMount, onDestroy } from "svelte";
  import { Editor, Node, Extension, mergeAttributes, InputRule } from "@tiptap/core";
  import Document from "@tiptap/extension-document";
  import Paragraph from "@tiptap/extension-paragraph";
  import Text from "@tiptap/extension-text";
  import History from "@tiptap/extension-history";
  import { baseKeymap } from "@tiptap/pm/commands";
  import { Fragment, Slice, type Node as PMNode, type Schema } from "@tiptap/pm/model";
  import { TextSelection } from "@tiptap/pm/state";

  export let prompt: string = "";
  export let isEditable: boolean = true;
  export let videoWorkflowType: string = "";
  export let promptRelayMode: boolean = false;
  export let refItems: { kind: "video" | "image"; token: string; url: string; label: string }[] = [];
  export let referencedTokens: string[] = [];
  export let availableRefs: { kind: "video" | "image"; token: string; url: string; label: string }[] = [];

  const MAX_PROMPT_CHARS = 10000; // matches DB VarChar(10000)

  let editorEl: HTMLDivElement | undefined;
  let editor: Editor | undefined;
  // Ref picker <details> — closed programmatically after inserting a token,
  // mirroring the ref2v preset dropdown behavior.
  let refPickerEl: HTMLDetailsElement | undefined;
  function closeRefPicker() {
    if (refPickerEl) refPickerEl.removeAttribute("open");
  }

  // ---------- ReferenceToken node ----------
  // Atom inline node: renders a badge chip (thumbnail for images, video icon
  // for videos) and serializes back to its literal <Picture N> / <Video 1>
  // text via renderText, so the prompt round-trips byte-for-byte.
  const TOKEN_RE = /^<(Picture|Video)\s*(\d+)>$/;

  function refAttrsFor(token: string) {
    const ref = refItems.find((r) => r.token === token);
    const kind = /^<Video\s*1>$/i.test(token) ? "video" : /^<Picture\s*\d+>$/i.test(token) ? "image" : "";
    return { token, kind: ref?.kind ?? kind, url: ref?.url ?? "", label: ref?.label ?? token };
  }

  const ReferenceToken = Node.create({
    name: "referenceToken",
    group: "inline",
    inline: true,
    atom: true,
    addAttributes() {
      return {
        token: { default: "" },
        kind: { default: "" },
        url: { default: "" },
        label: { default: "" },
      };
    },
    parseHTML() {
      return [
        {
          tag: "span[data-ref-token]",
          getAttrs: (el) => {
            const e = el as HTMLElement;
            return {
              token: e.getAttribute("data-ref-token") || "",
              kind: e.getAttribute("data-ref-kind") || "",
              url: e.getAttribute("data-ref-url") || "",
              label: e.getAttribute("data-ref-label") || "",
            };
          },
        },
      ];
    },
    renderHTML({ node, HTMLAttributes }) {
      const { token, kind, url } = node.attrs;
      const children: any[] = [];
      if (kind === "image" && url) {
        children.push(["img", { src: url, alt: "", class: "w-3.5 h-3.5 rounded object-cover inline-block align-middle" }]);
      } else if (kind === "video") {
        children.push([
          "svg",
          { class: "w-3.5 h-3.5 inline-block align-middle", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2" },
          ["rect", { x: "2", y: "6", width: "20", height: "12", rx: "2" }],
          ["path", { d: "m10 9 5 3-5 3z" }],
        ]);
      }
      children.push(["span", token]);
      return [
        "span",
        mergeAttributes(HTMLAttributes, {
          "data-ref-token": token,
          "data-ref-kind": node.attrs.kind,
          "data-ref-url": url,
          "data-ref-label": node.attrs.label,
          class: "inline-flex items-center gap-1 badge badge-primary badge-sm font-normal px-1.5 py-0.5 align-middle",
          contenteditable: "false",
        }),
        ...children,
      ];
    },
    renderText({ node }) {
      return node.attrs.token;
    },
    addInputRules() {
      // Typing <Picture N> / <Video 1> live-converts to a badge.
      return [
        new InputRule({
          find: /(?:<Picture|Video)\s*\d+>$/,
          // The input-rules plugin shares its transaction via `state.tr` and
          // applies it when it has steps — mutate it and return nothing.
          handler: ({ state, range, match }) => {
            state.tr.replaceWith(range.from, range.to, state.schema.nodes.referenceToken.create(refAttrsFor(match[0] || "")));
          },
        }),
      ];
    },
  });

  // Default ProseMirror keymap (Enter splits blocks, Backspace/Delete, arrow
  // keys...) — TipTap doesn't ship one without StarterKit. Undo/redo is
  // handled by History, so those bindings are excluded to avoid conflicts.
  const BaseKeymap = Extension.create({
    name: "baseKeymap",
    addKeyboardShortcuts() {
      const { editor } = this;
      const shortcuts: Record<string, () => boolean> = {};
      for (const [key, command] of Object.entries(baseKeymap)) {
        if (key === "Mod-z" || key === "Mod-y" || key === "Shift-Mod-z") continue;
        shortcuts[key] = () => command(editor.state, editor.view.dispatch, editor.view);
      }
      return shortcuts;
    },
  });

  // ---------- Prompt <-> editor text ----------
  function editorText(): string {
    return editor ? editor.getText({ blockSeparator: "\n" }) : prompt;
  }

  /** Build a ProseMirror fragment from the raw prompt string: each line a
   *  paragraph, tokens as referenceToken nodes. Pure node construction (no
   *  HTML parsing), so whitespace and token text round-trip exactly. */
  function buildFragmentFromPrompt(text: string, schema: Schema): Fragment {
    const blocks: PMNode[] = [];
    for (const line of text.split("\n")) {
      const inline: PMNode[] = [];
      for (const part of line.split(/(<(?:Picture|Video)\s*\d+>)/g)) {
        if (!part) continue;
        if (TOKEN_RE.test(part)) {
          inline.push(schema.nodes.referenceToken.create(refAttrsFor(part)));
        } else {
          inline.push(schema.text(part));
        }
      }
      blocks.push(schema.nodes.paragraph.create(null, inline));
    }
    return Fragment.fromArray(blocks);
  }

  /** Replace the whole document with the given fragment, optionally placing
   *  the caret at the end. Used for external prompt sync and truncation. */
  function replaceEditorContent(fragment: Fragment, caretAtEnd: boolean) {
    if (!editor) return;
    const tr = editor.state.tr.replaceWith(0, editor.state.doc.content.size, fragment);
    if (caretAtEnd) {
      tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size));
    }
    editor.view.dispatch(tr);
  }

  function handleUpdate() {
    if (!editor) return;
    let next = editorText();
    // Hard cap at the DB column limit: pasting/typing past MAX_PROMPT_CHARS
    // would make the server 500 on write. Trim to the limit (never silently
    // drop the whole prompt — the user's text is preserved up to the cap).
    if (next.length > MAX_PROMPT_CHARS) {
      next = next.slice(0, MAX_PROMPT_CHARS);
      replaceEditorContent(buildFragmentFromPrompt(next, editor.schema), true);
    }
    prompt = next;
  }

  onMount(() => {
    if (!editorEl) return;
    editor = new Editor({
      element: editorEl,
      extensions: [Document, Paragraph, Text, History, BaseKeymap, ReferenceToken],
      content: "",
      editable: isEditable,
      editorProps: {
        attributes: {
          id: "prompt",
          class: "prompt-editor",
          tabindex: "0",
          "aria-label": $_("review.yourPrompt"),
          "aria-multiline": "true",
        },
        // Paste as plain text (tokens become badges), replacing the selection.
        handlePaste: (view, event) => {
          const text = event.clipboardData?.getData("text/plain");
          if (text == null) return false;
          const fragment = buildFragmentFromPrompt(text, view.state.schema);
          view.dispatch(view.state.tr.replaceSelection(Slice.maxOpen(fragment)));
          return true;
        },
      },
      onUpdate: () => handleUpdate(),
    });
  });

  onDestroy(() => {
    editor?.destroy();
    editor = undefined;
  });

  // Reflect external prompt changes (suggestion click, relay AI, entry sync)
  // into the editor — but only when the text actually differs, so typing
  // (which writes prompt from the editor) never fights the editor.
  $: if (editor && !editor.isDestroyed && prompt !== editorText()) {
    replaceEditorContent(buildFragmentFromPrompt(prompt, editor.schema), false);
  }

  // Read-only mode.
  $: if (editor) editor.setEditable(isEditable);

  function insertRefToken(token: string) {
    if (!isEditable || !editor) return;
    // Pad the token with a space only where the neighboring text isn't
    // already whitespace (same separators as the old editor).
    const { from, to } = editor.state.selection;
    const doc = editor.state.doc;
    const leaf = (n: PMNode) => (n.type.name === "referenceToken" ? n.attrs.token : n.text || "");
    const before = doc.textBetween(0, from, "\n", leaf);
    const after = doc.textBetween(to, doc.content.size, "\n", leaf);
    const nodes: PMNode[] = [];
    if (before && !/\s$/.test(before)) nodes.push(editor.schema.text(" "));
    nodes.push(editor.schema.nodes.referenceToken.create(refAttrsFor(token)));
    if (after && !/^\s/.test(after)) nodes.push(editor.schema.text(" "));
    editor.chain().focus().insertContent(Fragment.fromArray(nodes)).run();
    closeRefPicker();
  }

  function insertAllRefTokens() {
    if (!isEditable || !editor || availableRefs.length === 0) return;
    const schema = editor.schema;
    // Append every not-yet-referenced token at the end of the prompt.
    const doc = editor.state.doc;
    const end = doc.content.size;
    const leaf = (n: PMNode) => (n.type.name === "referenceToken" ? n.attrs.token : n.text || "");
    const before = doc.textBetween(0, end, "\n", leaf);
    const nodes: PMNode[] = [];
    if (before && !/\s$/.test(before)) nodes.push(schema.text(" "));
    availableRefs.forEach((r, i) => {
      if (i > 0) nodes.push(schema.text(" "));
      nodes.push(schema.nodes.referenceToken.create({ token: r.token, kind: r.kind, url: r.url, label: r.label }));
    });
    editor.chain().focus().insertContentAt(end, Fragment.fromArray(nodes)).run();
    closeRefPicker();
  }
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

  <!-- TipTap mounts its editable .ProseMirror element inside this host; the
       daisyUI textarea chrome stays on the host. -->
  <div class="prompt-editor-host textarea textarea-bordered textarea-lg w-full cursor-text">
    <div bind:this={editorEl}></div>
  </div>

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

<style>
  /* TipTap mounts .ProseMirror inside the host; make it look like the plain
     textarea it replaces (daisyUI textarea-lg vertical padding ≈ 0.875rem). */
  :global(.prompt-editor-host .ProseMirror) {
    outline: none;
    min-height: 6.25rem;
    white-space: pre-wrap;
  }
  :global(.prompt-editor-host .ProseMirror:focus) {
    outline: none;
  }
  :global(.prompt-editor-host .ProseMirror p) {
    margin: 0;
  }
</style>
