/**
 * Display equation numbers in Live Preview.
 */

import { EditorState, StateEffect } from '@codemirror/state';
import { PluginValue, ViewPlugin, EditorView, ViewUpdate } from '@codemirror/view';
import { EquationBlock, MarkdownBlock, MarkdownPage, TheoremCalloutBlock } from 'index/typings/markdown';
import LatexReferencer from 'main';
import { MarkdownView, TFile, editorInfoField, finishRenderMath } from 'obsidian';
import { resolveSettings } from 'utils/plugin';
import { replaceMathTag } from './common';
import { DEFAULT_SETTINGS, MathContextSettings } from 'settings/settings';


export function createEquationNumberPlugin(plugin: LatexReferencer) {

    const { app, indexManager: { index } } = plugin;

    const forceUpdateEffect = StateEffect.define<null>();

    plugin.registerEvent(plugin.indexManager.on('index-updated', (file) => {
        app.workspace.iterateAllLeaves((leaf) => {
            if (
                leaf.view instanceof MarkdownView
                && leaf.view.file?.path === file.path
                && leaf.view.getMode() === 'source'
            ) {
                leaf.view.editor.cm?.dispatch({ effects: forceUpdateEffect.of(null) });
            }
        });
    }));

    return ViewPlugin.fromClass(class implements PluginValue {
        file: TFile | null;
        page: MarkdownPage | null;
        settings: Required<MathContextSettings>;

        constructor(view: EditorView) {
            this.file = view.state.field(editorInfoField).file;
            this.page = null;
            this.settings = DEFAULT_SETTINGS;

            if (this.file) {
                this.settings = resolveSettings(undefined, plugin, this.file);
                const page = index.load(this.file.path);
                if (MarkdownPage.isMarkdownPage(page)) {
                    this.page = page;
                    this.updateEquationNumber(view, this.page);
                }
            }
        }

        updateFile(state: EditorState) {
            this.file = state.field(editorInfoField).file;
            if (this.file) this.settings = resolveSettings(undefined, plugin, this.file);
        }

        async updatePage(file: TFile): Promise<MarkdownPage> {
            const page = index.load(file.path);
            if (MarkdownPage.isMarkdownPage(page)) this.page = page;
            if (!this.page) {
                this.page = await plugin.indexManager.reload(file);
            }
            return this.page;
        }

        update(update: ViewUpdate) {
            if (!this.file) this.updateFile(update.state);
            if (!this.file) return;

            if (update.transactions.some(tr => tr.effects.some(effect => effect.is(forceUpdateEffect)))) {
                // index updated
                this.settings = resolveSettings(undefined, plugin, this.file);
                this.updatePage(this.file).then((updatedPage) => this.updateEquationNumber(update.view, updatedPage))
            } else if (update.geometryChanged) {
                if (this.page) this.updateEquationNumber(update.view, this.page);
                else this.updatePage(this.file).then((updatedPage) => this.updateEquationNumber(update.view, updatedPage));
            }
        }

        async updateEquationNumber(view: EditorView, page: MarkdownPage) {
            // Top-level display math (original selector)
            const topLevelMjx = view.contentDOM.querySelectorAll<HTMLElement>(':scope > .cm-embed-block.math > mjx-container.MathJax[display="true"]');
            // Display math inside callouts
            const calloutMjx = view.contentDOM.querySelectorAll<HTMLElement>('.callout mjx-container.MathJax[display="true"]');
            const mjxContainerElements = Array.from(topLevelMjx); // avoid duplicate if same node matches both
            for (const el of calloutMjx) {
                if (!mjxContainerElements.includes(el)) mjxContainerElements.push(el);
            }

            for (const mjxContainerEl of mjxContainerElements) {

                // skip if the equation is being edited to avoid the delay of preview
                const mightBeClosingDollars = mjxContainerEl.parentElement?.previousElementSibling?.lastElementChild;
                const isBeingEdited = mightBeClosingDollars?.matches('span.cm-formatting-math-end');
                if (isBeingEdited) continue;

                const pos = view.posAtDOM(mjxContainerEl);
                let block: MarkdownBlock | undefined;
                try {
                    const line = view.state.doc.lineAt(pos).number - 1; // sometimes throws an error for reasons that I don't understand
                    block = page.getBlockByLineNumber(line);
                } catch (err) {
                    block = page.getBlockByOffset(pos);
                }

                let equation: EquationBlock | null = null;
                if (block instanceof EquationBlock) {
                    equation = block;
                } else if (block && TheoremCalloutBlock.isTheoremCalloutBlock(block)) {
                    // Equation is inside a theorem callout: match by DOM order
                    const calloutEl = mjxContainerEl.closest<HTMLElement>('.callout');
                    if (calloutEl) {
                        const mjxInCallout = calloutEl.querySelectorAll<HTMLElement>('mjx-container.MathJax[display="true"]');
                        const ourIndex = Array.from(mjxInCallout).indexOf(mjxContainerEl);
                        if (ourIndex >= 0) {
                            const equationsInRange = page.getEquationBlocksInRange(block.$position.start, block.$position.end);
                            equation = equationsInRange[ourIndex] ?? null;
                        }
                    }
                }
                if (!equation) continue;

                // only update if necessary
                if (mjxContainerEl.getAttribute('data-equation-print-name') !== equation.$printName) {
                    replaceMathTag(mjxContainerEl, equation, this.settings);
                }
                if (equation.$printName !== null) mjxContainerEl.setAttribute('data-equation-print-name', equation.$printName);
                else mjxContainerEl.removeAttribute('data-equation-print-name');
            }
            // DON'T FOREGET THIS CALL!!
            // https://github.com/RyotaUshio/obsidian-latex-theorem-equation-referencer/issues/203
            // https://github.com/RyotaUshio/obsidian-latex-theorem-equation-referencer/issues/200
            finishRenderMath();
        }

        destroy() {
            // I don't know if this is really necessary, but just in case...
            finishRenderMath();
        }
    });
}
