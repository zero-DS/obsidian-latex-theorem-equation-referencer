/** borrowed from WANGshouming4937/obsidian-latex-theorem-equation-referencer*/
/**
 * Display equation numbers in reading view, embeds, hover page preview, and PDF export.
 */

import { App, MarkdownRenderChild, finishRenderMath, MarkdownPostProcessorContext, TFile, Notice } from "obsidian";

import LatexReferencer from 'main';
import { resolveSettings } from 'utils/plugin';
import { EquationBlock, MarkdownPage, TheoremCalloutBlock } from "index/typings/markdown";
import { MathIndex } from "index/math-index";
import { isPdfExport, resolveLinktext } from "utils/obsidian";
import { replaceMathTag } from "./common";


export const createEquationNumberProcessor = (plugin: LatexReferencer) => async (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
    if (isPdfExport(el)) preprocessForPdfExport(plugin, el, ctx);

    const sourceFile = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
    if (!(sourceFile instanceof TFile)) return;

    const mjxContainerElements = el.querySelectorAll<HTMLElement>('mjx-container.MathJax[display="true"]');
    for (const mjxContainerEl of mjxContainerElements) {
        ctx.addChild(
            new EquationNumberRenderer(mjxContainerEl, plugin, sourceFile, ctx)
        );
    }
    finishRenderMath();
}


/** 
 * As a preprocessing for displaying equation numbers in the exported PDF, 
 * add an attribute representing a block ID to each numbered equation element
 * so that EquationNumberRenderer can find the corresponding block from the index
 * without relying on the line number.
 */
function preprocessForPdfExport(plugin: LatexReferencer, el: HTMLElement, ctx: MarkdownPostProcessorContext) {

    try {
        // 使用更宽松的选择器来匹配PDF导出环境中的公式元素
        let topLevelMathDivs = el.querySelectorAll<HTMLElement>(':scope > div.math.math-block > mjx-container.MathJax[display="true"]');
        
        // 如果没有找到元素，尝试更宽松的选择器
        if (topLevelMathDivs.length === 0) {
            console.log(`${plugin.manifest.name}: PDF Export - Trying alternative selector for math elements`);
            topLevelMathDivs = el.querySelectorAll<HTMLElement>('mjx-container.MathJax[display="true"]');
        }

        const page = plugin.indexManager.index.getMarkdownPage(ctx.sourcePath);
        if (!page) {
            new Notice(`${plugin.manifest.name}: Failed to fetch the metadata for PDF export; equation numbers will not be displayed in the exported PDF.`);
            return;
        }

        // First collect all equation blocks
        const equationBlocks = [];
        for (const section of page.$sections) {
            for (const block of section.$blocks) {
                if (EquationBlock.isEquationBlock(block)) {
                    equationBlocks.push(block);
                }
            }
        }

        // Add debug logging
        console.log(`${plugin.manifest.name}: PDF Export - Found ${equationBlocks.length} equation blocks and ${topLevelMathDivs.length} DOM elements`);
        
        // Now match equation blocks with DOM elements
        // 为了确保匹配的准确性，我们假设DOM中的公式顺序与方程块的顺序一致
        // 因为我们已经在preprocessForPdfExport函数中收集了所有方程块
        if (equationBlocks.length === topLevelMathDivs.length) {
            // 如果数量匹配，直接按顺序匹配
            for (let i = 0; i < equationBlocks.length; i++) {
                const block = equationBlocks[i];
                const div = topLevelMathDivs[i];
                
                // 为所有公式设置data-equation-id属性
                div.setAttribute('data-equation-id', block.$id);
                
                if (!block.$printName) {
                    console.log(`${plugin.manifest.name}: PDF Export - Setting ID for block ${block.$id} without printName`);
                } else {
                    console.log(`${plugin.manifest.name}: PDF Export - Set data-equation-id=${block.$id} for DOM element ${i}`);
                }
            }
        } else {
            // 如果数量不匹配，记录警告但仍然尝试匹配
            console.log(`${plugin.manifest.name}: PDF Export - Warning: Mismatch between equation blocks (${equationBlocks.length}) and DOM elements (${topLevelMathDivs.length})`);
            
            // 只匹配可用的元素
            const minCount = Math.min(equationBlocks.length, topLevelMathDivs.length);
            for (let i = 0; i < minCount; i++) {
                const block = equationBlocks[i];
                const div = topLevelMathDivs[i];
                div.setAttribute('data-equation-id', block.$id);
            }
        }
    } catch (err) {
        const msg = `${plugin.manifest.name}: Error during PDF export preprocessing. See console for details.`;
        console.error(msg, err);
        new Notice(msg);
    }
}


export class EquationNumberRenderer extends MarkdownRenderChild {
    app: App
    index: MathIndex;

    constructor(containerEl: HTMLElement, public plugin: LatexReferencer, public file: TFile, public context: MarkdownPostProcessorContext) {
        // containerEl, currentEL are mjx-container.MathJax elements
        super(containerEl);
        this.app = plugin.app;
        this.index = this.plugin.indexManager.index;

        this.registerEvent(this.plugin.indexManager.on("index-initialized", () => {
            setTimeout(() => this.update());
        }));
    
        this.registerEvent(this.plugin.indexManager.on("index-updated", (file) => {
            setTimeout(() => {
                if (file.path === this.file.path) this.update();
            });
        }));
    }

    getEquationCache(lineOffset: number = 0): EquationBlock | null {
        const info = this.context.getSectionInfo(this.containerEl);
        const page = this.index.getMarkdownPage(this.file.path);
        if (!info || !page) return null;

        const block = page.getBlockByLineNumber(info.lineStart + lineOffset) ?? page.getBlockByLineNumber(info.lineEnd + lineOffset);
        if (EquationBlock.isEquationBlock(block)) return block;

        // Equation is inside a callout: getSectionInfo returns the callout block. Match by DOM order.
        if (block && TheoremCalloutBlock.isTheoremCalloutBlock(block)) {
            const calloutEl = this.containerEl.closest<HTMLElement>('.callout');
            if (!calloutEl) return null;
            const mjxInCallout = calloutEl.querySelectorAll<HTMLElement>('mjx-container.MathJax[display="true"]');
            const ourIndex = Array.from(mjxInCallout).indexOf(this.containerEl);
            if (ourIndex < 0) return null;
            const equationsInRange = page.getEquationBlocksInRange(info.lineStart, info.lineEnd);
            return equationsInRange[ourIndex] ?? null;
        }

        return null;
    }

    async onload() {
        setTimeout(() => this.update());
    }

    onunload() {
        // I don't know if this is really necessary, but just in case...
        finishRenderMath();
    }

    update() {
        // for PDF export
        const id = this.containerEl.getAttribute('data-equation-id');

        const equation = id ? this.index.getEquationBlock(id) : this.getEquationCacheCaringHoverAndEmbed();
        if (!equation) return;
        const settings = resolveSettings(undefined, this.plugin, this.file);
        replaceMathTag(this.containerEl, equation, settings);
    }

    getEquationCacheCaringHoverAndEmbed(): EquationBlock | null {
        /**
         * https://github.com/RyotaUshio/obsidian-latex-theorem-equation-referencer/issues/179
         * 
         * In the case of embeds or hover popovers, the line numbers contained 
         * in the result of MarkdownPostProcessorContext.getSectionInfo() is 
         * relative to the content included in the embed.
         * In other words, they does not always represent the offset from the beginning of the file.
         * So they require special handling.
         */

        const equation = this.getEquationCache();

        let linktext = this.containerEl.closest('[src]')?.getAttribute('src'); // in the case of embeds

        if (!linktext) {
            const hoverEl = this.containerEl.closest<HTMLElement>('.hover-popover:not(.hover-editor)');
            if (hoverEl) {
                // The current context is hover page preview; read the linktext saved in the plugin instance.
                linktext = this.plugin.lastHoverLinktext;
            }
        }

        if (linktext) { // linktext was found
            const { file, subpathResult } = resolveLinktext(this.app, linktext, this.context.sourcePath) ?? {};

            if (!file || !subpathResult) return null;

            const page = this.index.load(file.path);
            if (!MarkdownPage.isMarkdownPage(page)) return null;

            if (subpathResult.type === "block") {
                const block = page.$blocks.get(subpathResult.block.id);
                if (!EquationBlock.isEquationBlock(block)) return null;
                return block;
            } else {
                return this.getEquationCache(subpathResult.start.line);
            }
        }

        return equation;
    }
}