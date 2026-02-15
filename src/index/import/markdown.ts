import { Link } from "index/expression/link";
import { getFileTitle } from "index/utils/normalizers";
import { CachedMetadata, SectionCache } from "obsidian";
import BTree from "sorted-btree";
import {
    JsonMarkdownBlock,
    JsonMarkdownPage,
    JsonMarkdownSection,
    JsonTheoremCalloutBlock,
    JsonEquationBlock,
} from "index/typings/json";
import { MinimalTheoremCalloutSettings } from "settings/settings";
import { parseMarkdownComment, parseYamlLike, readTheoremCalloutSettings, trimMathText } from "utils/parse";
import { parseLatexComment } from "utils/parse";


/**
 * Given the raw source and Obsidian metadata for a given markdown file,
 * return full markdown file metadata.
 */
export function markdownImport(
    path: string,
    markdown: string,
    metadata: CachedMetadata,
    excludeExample: boolean
): JsonMarkdownPage {
    // Total length of the file.
    const lines = markdown.split("\n");
    const empty = !lines.some((line) => line.trim() !== "");

    //////////////
    // Sections //
    //////////////

    const metaheadings = metadata.headings ?? [];
    metaheadings.sort((a, b) => a.position.start.line - b.position.start.line);

    const sections = new BTree<number, JsonMarkdownSection>(undefined, (a, b) => a - b);
    for (let index = 0; index < metaheadings.length; index++) {
        const section = metaheadings[index];
        const start = section.position.start.line;
        const end =
            index == metaheadings.length - 1 ? lines.length - 1 : metaheadings[index + 1].position.start.line - 1;

        sections.set(start, {
            $ordinal: index + 1,
            $title: section.heading,
            $level: section.level,
            $position: { start, end },
            $blocks: [],
            $links: [],
        });
    }

    // Add an implicit section for the "heading" section of the page if there is not an immediate header but there is
    // some content in the file. If there are other sections, then go up to that, otherwise, go for the entire file.
    const firstSection: [number, JsonMarkdownSection] | undefined = sections.getPairOrNextHigher(0);
    if ((!firstSection && !empty) || (firstSection && !emptylines(lines, 0, firstSection[1].$position.start))) {
        const end = firstSection ? firstSection[1].$position.start - 1 : lines.length;
        sections.set(0, {
            $ordinal: 0,
            $title: getFileTitle(path),
            $level: 1,
            $position: { start: 0, end },
            $blocks: [],
            $links: [],
        });
    }

    ////////////
    // Blocks //
    ////////////

    // All blocks; we will assign tags and other metadata to blocks as we encounter them. At the end, only blocks that
    // have actual metadata will be stored to save on memory pressure.
    const blocks = new BTree<number, JsonMarkdownBlock>(undefined, (a, b) => a - b);
    let blockOrdinal = 1;
    for (const block of metadata.sections || []) {
        // Skip headings blocks, we handle them specially as sections.
        if (block.type === "heading") continue;

        const start = block.position.start.line;
        const end = block.position.end.line;

        let theoremCalloutSettings: MinimalTheoremCalloutSettings | null = null;
        let v1 = false;
        if (block.type === "callout") {
            const settings = readTheoremCalloutSettings(lines[start], excludeExample);
            theoremCalloutSettings = settings ?? null;
            v1 = !!(settings?.legacy);
        }

        if (block.type === "math") {
            // Read the LaTeX source
            const mathText = trimMathText(getBlockText(markdown, block));

            // If manually tagged (`\tag{...}`), extract the tag
            const tagMatch = mathText.match(/\\tag\{(.*)\}/);

            // Parse additional metadata from LaTeX comments
            const metadata: Record<string, string | undefined> = {};
            for (const line of mathText.split('\n')) {
                const { comment } = parseLatexComment(line);
                if (!comment) continue;
                Object.assign(metadata, parseYamlLike(comment));
            }

            blocks.set(start, {
                $ordinal: blockOrdinal++,
                $position: { start, end },
                $pos: block.position,
                $links: [],
                $blockId: block.id,
                $manualTag: tagMatch?.[1] ?? null,
                $mathText: mathText,
                $type: "equation",
                $label: metadata.label,
                $display: metadata.display,
            } as JsonEquationBlock);
        } else if (theoremCalloutSettings) {

            // Create equation blocks for display math inside the callout so they get numbers
            const calloutBlockText = getBlockText(markdown, block);
            const equationsInCallout = findDisplayMathInCalloutBlock(
                calloutBlockText,
                start,
                block.position.start.offset
            );
            for (const eq of equationsInCallout) {
                const tagMatch = eq.mathText.match(/\\tag\{(.*)\}/);
                const metadata: Record<string, string | undefined> = {};
                for (const line of eq.mathText.split('\n')) {
                    const { comment } = parseLatexComment(line);
                    if (!comment) continue;
                    Object.assign(metadata, parseYamlLike(comment));
                }
                const pos = {
                    start: { line: eq.lineStart, col: 0, offset: eq.startOffset },
                    end: { line: eq.lineEnd, col: 0, offset: eq.endOffset },
                };
                blocks.set(eq.lineStart, {
                    $ordinal: blockOrdinal++,
                    $position: { start: eq.lineStart, end: eq.lineEnd },
                    $pos: pos,
                    $links: [],
                    $blockId: undefined,
                    $manualTag: tagMatch?.[1] ?? null,
                    $mathText: eq.mathText,
                    $type: "equation",
                    $label: metadata.label,
                    $display: metadata.display,
                } as JsonEquationBlock);
            }

            // Parse additional metadata from Markdown comments
            const contentText = lines.slice(start + 1, end + 1).join('\n');
            const commentLines = parseMarkdownComment(contentText);
            const metadata: Record<string, string | undefined> = {};
            for (let line of commentLines) {
                if (line.startsWith('>')) line = line.slice(1).trim();
                if (!line) continue;
                if (line === 'main') metadata.main = 'true'; // %% main %% is the same as %% main: true %%
                else Object.assign(metadata, parseYamlLike(line));
            }

            blocks.set(start, {
                $ordinal: blockOrdinal++,
                $position: { start, end },
                $pos: block.position,
                $links: [],
                $blockId: block.id,
                $settings: theoremCalloutSettings,
                $type: "theorem",
                $label: metadata.label,
                $display: metadata.display,
                $main: metadata.main === 'true',
                $v1: v1,
            } as JsonTheoremCalloutBlock);
        } else {
            blocks.set(start, {
                $ordinal: blockOrdinal++,
                $position: { start, end },
                $pos: block.position,
                $links: [],
                $blockId: block.id,
                $type: block.type,
            });
        }
    }

    // Add blocks to sections.
    for (const block of blocks.values() as Iterable<JsonMarkdownBlock>) {
        const section = sections.getPairOrNextLower(block.$position.start);

        if (section && section[1].$position.end >= block.$position.end) {
            section[1].$blocks.push(block);
        }
    }

    ///////////
    // Links //
    ///////////

    const links: Link[] = [];
    for (let linkdef of metadata.links ?? []) {
        const link = Link.infer(linkdef.link);
        const line = linkdef.position.start.line;
        addLink(links, link);

        const section = sections.getPairOrNextLower(line);
        if (section && section[1].$position.end >= line) addLink(section[1].$links, link);

        const block = blocks.getPairOrNextLower(line);
        if (block && block[1].$position.end >= line) addLink(block[1].$links, link);

        const listItem = blocks.getPairOrNextHigher(line);
        if (listItem && listItem[1].$position.end >= line) addLink(listItem[1].$links, link);
    }

    ///////////////////////
    // Frontmatter Links //
    ///////////////////////

    // Frontmatter links are only assigned to the page.
    for (const linkdef of metadata.frontmatterLinks ?? []) {
        const link = Link.infer(linkdef.link, false, linkdef.displayText);
        addLink(links, link);
    }

    return {
        $path: path,
        $links: links,
        $sections: sections.valuesArray(),
        $extension: "md",
        $position: { start: 0, end: lines.length },
    };
}

/** Check if the given line range is all empty. Start is inclusive, end exclusive. */
function emptylines(lines: string[], start: number, end: number): boolean {
    for (let index = start; index < end; index++) {
        if (lines[index].trim() !== "") return false;
    }

    return true;
}

/**
 * Mutably add the given link to the list only if it is not already present.
 * This is O(n) but should be fine for most files; we could eliminate the O(n) by instead
 * using intermediate sets but not worth the complexity.
 */
function addLink(target: Link[], incoming: Link) {
    if (target.find((v) => v.equals(incoming))) return;
    target.push(incoming);
}

function getBlockText(data: string, block: SectionCache) {
    return data.slice(block.position.start.offset, block.position.end.offset);
}

/**
 * Find all display math ($$...$$) in callout block content and return their positions and math text.
 * Used to create equation blocks for equations inside theorem callouts so they get numbers.
 */
function findDisplayMathInCalloutBlock(
    blockText: string,
    blockStartLine: number,
    blockStartOffset: number
): { lineStart: number; lineEnd: number; startOffset: number; endOffset: number; mathText: string }[] {
    const results: { lineStart: number; lineEnd: number; startOffset: number; endOffset: number; mathText: string }[] = [];
    const delimiter = '$$';
    let i = 0;
    while ((i = blockText.indexOf(delimiter, i)) !== -1) {
        const startDelim = i;
        i += delimiter.length;
        const endDelim = blockText.indexOf(delimiter, i);
        if (endDelim === -1) break;
        let mathText = blockText.slice(i, endDelim).trim();
        // Strip callout line prefix "> " from each line so LaTeX is clean
        mathText = mathText.split('\n').map((line) => line.replace(/^>\s?/, '')).join('\n').trim();
        const endOffset = endDelim + delimiter.length;

        const textBeforeStart = blockText.slice(0, startDelim);
        const textBeforeEnd = blockText.slice(0, endDelim);
        const lineStart = blockStartLine + (textBeforeStart.split('\n').length - 1);
        const lineEnd = blockStartLine + (textBeforeEnd.split('\n').length - 1);

        results.push({
            lineStart,
            lineEnd,
            startOffset: blockStartOffset + startDelim,
            endOffset: blockStartOffset + endOffset,
            mathText,
        });
        i = endOffset;
    }
    return results;
}