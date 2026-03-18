import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as pdfParse from "pdf-parse";
import { ExecutorService } from "../executor/executor.service";

export interface ExtractedCode {
	code: string;
	description: string;
	category: string;
}

export interface ExtractionResult {
	articleId: string;
	title: string;
	effectiveDate: string;
	codes: ExtractedCode[];
	extractionMethod: "regex" | "llm" | "hybrid";
	confidence: number;
}

@Injectable()
export class ExtractorService {
	private readonly logger = new Logger(ExtractorService.name);
	private readonly confidenceThreshold: number;

	// Category mappings for diabetes codes
	private readonly CATEGORY_MAP: Record<string, string> = {
		E08: "Diabetes due to underlying condition",
		E09: "Drug or chemical induced diabetes",
		E10: "Type 1 diabetes mellitus",
		E11: "Type 2 diabetes mellitus",
		E13: "Other specified diabetes mellitus",
		O24: "Diabetes mellitus in pregnancy",
	};

	constructor(
		private readonly configService: ConfigService,
		private readonly executorService: ExecutorService
	) {
		this.confidenceThreshold = parseInt(
			this.configService.get<string>("REGEX_CONFIDENCE_THRESHOLD") || "85",
			10
		);
	}

	/**
	 * Main extraction method - uses hybrid approach or request overrides
	 */
	async extractFromPDF(
		buffer: Buffer,
		options?: { provider?: string; temperature?: number }
	): Promise<ExtractionResult> {
		this.logger.log("Starting PDF extraction...");

		// Parse PDF to text
		const data = await pdfParse(buffer);
		const text = data.text;

		// Extract metadata
		const articleId = this.extractArticleId(text);
		const title = this.extractTitle(text);
		const effectiveDate = this.extractEffectiveDate(text);

		// Try regex extraction first
		const regexResult = this.extractCodesWithRegex(text);
		const regexConfidence = this.calculateConfidence(regexResult, text);

		this.logger.log(
			`Regex extraction: ${regexResult.length} codes, confidence: ${regexConfidence}%`
		);

		// If user requested regex only, use regex result regardless of confidence
		if (options?.provider === "regex") {
			this.logger.log("Using regex only (provider=regex)");
			const deduped = this.deduplicateExtractedCodes(regexResult);
			if (deduped.length !== regexResult.length) {
				this.logger.log(`Deduplicated regex codes: ${regexResult.length} -> ${deduped.length}`);
			}
			return {
				articleId,
				title,
				effectiveDate,
				codes: deduped,
				extractionMethod: "regex",
				confidence: regexConfidence,
			};
		}

		// If regex confidence is high enough, use it (unless an LLM provider was explicitly requested)
		const forceLLM = options?.provider === "openai" || options?.provider === "gemini";
		if (!forceLLM && regexConfidence >= this.confidenceThreshold) {
			this.logger.log(`Using regex extraction (confidence ${regexConfidence}% >= threshold ${this.confidenceThreshold}%)`);
			const deduped = this.deduplicateExtractedCodes(regexResult);
			if (deduped.length !== regexResult.length) {
				this.logger.log(`Deduplicated regex codes: ${regexResult.length} -> ${deduped.length}`);
			}
			return {
				articleId,
				title,
				effectiveDate,
				codes: deduped,
				extractionMethod: "regex",
				confidence: regexConfidence,
			};
		}

		// Try LLM extraction if enabled (and not regex-only)
		if (this.executorService.isEnabled() || forceLLM) {
			this.logger.log(
				forceLLM
					? `Using LLM extraction (provider=${options?.provider})`
					: `Regex confidence ${regexConfidence}% < threshold ${this.confidenceThreshold}%, using LLM fallback`
			);

			try {
				const llmResult = await this.executorService.extractCodesWithLLM(text, {
					provider: options?.provider as "openai" | "gemini" | undefined,
					temperature: options?.temperature,
				});
				const llmCodes = llmResult.codes.map((c) => {
					const { code, description } = this.normalizeCodeAndDescription(
						c.code,
						c.description || ""
					);
					return {
						code,
						description: this.repairDescriptionFirstLetter(description),
						category: this.getCategory(code),
					};
				});

				// Merge results if LLM found more codes (mergeCodes already deduplicates by code)
				if (llmCodes.length > regexResult.length) {
					const mergedCodes = this.deduplicateExtractedCodes(
						this.mergeCodes(regexResult, llmCodes)
					);
					this.logger.log(
						`LLM found ${llmCodes.length} codes, merged unique total: ${mergedCodes.length}`
					);
					return {
						articleId,
						title,
						effectiveDate,
						codes: mergedCodes,
						extractionMethod: "hybrid",
						confidence: Math.max(regexConfidence, llmResult.confidence),
					};
				}

				// Use LLM result if it has higher confidence
				if (llmResult.confidence > regexConfidence) {
					const deduped = this.deduplicateExtractedCodes(llmCodes);
					if (deduped.length !== llmCodes.length) {
						this.logger.log(`Deduplicated LLM codes: ${llmCodes.length} -> ${deduped.length}`);
					}
					return {
						articleId,
						title,
						effectiveDate,
						codes: deduped,
						extractionMethod: "llm",
						confidence: llmResult.confidence,
					};
				}
			} catch (error: any) {
				this.logger.warn(`LLM extraction failed, using regex result: ${error.message}`);
			}
		}

		// Fallback to regex result
		const deduped = this.deduplicateExtractedCodes(regexResult);
		if (deduped.length !== regexResult.length) {
			this.logger.log(`Deduplicated fallback regex codes: ${regexResult.length} -> ${deduped.length}`);
		}
		return {
			articleId,
			title,
			effectiveDate,
			codes: deduped,
			extractionMethod: "regex",
			confidence: regexConfidence,
		};
	}

	/**
	 * Deduplicate extracted codes by code string. Keeps first occurrence; prefers longer description when merging.
	 * Ensures output matches PDF (each code once) and avoids over-counting.
	 */
	private deduplicateExtractedCodes(codes: ExtractedCode[]): ExtractedCode[] {
		const byCode = new Map<string, ExtractedCode>();
		for (const c of codes) {
			const existing = byCode.get(c.code);
			if (!existing || (c.description && c.description.length > (existing.description?.length ?? 0))) {
				byCode.set(c.code, c);
			}
		}
		return Array.from(byCode.values()).sort((a, b) => a.code.localeCompare(b.code));
	}

	/**
	 * ICD-10-CM code pattern: letter + 2 digits + dot + 2-4 digits, optional 7th char = digit OR letter+digit.
	 * Avoids capturing a single trailing letter (e.g. D from "Diabetes", T from "Type") as part of the code.
	 */
	private static readonly ICD10_CODE_PATTERN = /^([A-Z]\d{2}\.\d{2,4}(?:\d|[A-Z]\d)?)\s*(.*)/;
	private static readonly ICD10_CODE_ONLY_PATTERN = /([A-Z]\d{2}\.\d{2,4}(?:\d|[A-Z]\d)?)/g;
	/** Match ICD-10 code at word boundary (for splitting descriptions that contain embedded codes) */
	private static readonly ICD10_EMBEDDED_PATTERN = /(?<![A-Za-z0-9.])([A-Z]\d{2}\.\d{2,4}(?:\d|[A-Z]\d)?)(?![A-Za-z0-9])/g;

	/**
	 * Extract codes using regex patterns
	 */
	private extractCodesWithRegex(text: string): ExtractedCode[] {
		const codes: ExtractedCode[] = [];
		const seenCodes = new Set<string>();

		// Find the ICD-10 codes section
		const sectionStart = text.indexOf("ICD-10-CM Codes that Support Medical Necessity");
		const sectionEnd = text.indexOf("ICD-10-CM Codes that DO NOT Support");

		let relevantText = text;
		if (sectionStart !== -1) {
			relevantText =
				sectionEnd !== -1
					? text.substring(sectionStart, sectionEnd)
					: text.substring(sectionStart);
		}

		// Normalize line breaks and remove "CodeDescription" merge artifacts before parsing
		relevantText = this.normalizeSectionText(relevantText);

		// Split text into lines for better parsing
		const lines = relevantText.split("\n");

		let currentCode: string | null = null;
		let currentDescription: string[] = [];

		for (const line of lines) {
			const trimmedLine = line.trim();

			// Check if line starts with an ICD-10 code (stricter pattern: no single trailing letter)
			const codeMatch = trimmedLine.match(ExtractorService.ICD10_CODE_PATTERN);

			if (codeMatch) {
				// Save previous code if exists (split at any embedded ICD codes mid-description)
				if (currentCode) {
					const rawDescription = currentDescription.join("\n").trim();
					if (rawDescription) {
						const { code, description: desc } = this.normalizeCodeAndDescription(
							currentCode,
							this.cleanDescription(rawDescription)
						);
						this.pushCodesWithEmbeddedSplit(codes, seenCodes, code, this.repairDescriptionFirstLetter(desc));
					}
				}

				// Start new code
				currentCode = codeMatch[1];
				currentDescription = codeMatch[2] ? [codeMatch[2]] : [];
			} else if (currentCode && trimmedLine && !this.isHeaderLine(trimmedLine)) {
				// Continue description from previous line
				currentDescription.push(trimmedLine);
			}
		}

		// Don't forget the last code
		if (currentCode) {
			const rawDescription = currentDescription.join("\n").trim();
			if (rawDescription) {
				const { code, description: desc } = this.normalizeCodeAndDescription(
					currentCode,
					this.cleanDescription(rawDescription)
				);
				this.pushCodesWithEmbeddedSplit(codes, seenCodes, code, this.repairDescriptionFirstLetter(desc));
			}
		}

		// Second pass: find any ICD-10 codes in the section we might have missed (merge/format issues)
		const missedCodes = this.findMissedCodes(relevantText, seenCodes);
		for (const { code, description } of missedCodes) {
			this.pushCodesWithEmbeddedSplit(
				codes,
				seenCodes,
				code,
				this.repairDescriptionFirstLetter(this.cleanDescription(description))
			);
		}

		// Sort codes
		codes.sort((a, b) => a.code.localeCompare(b.code));

		return codes;
	}

	/**
	 * Normalize section text: fix "CodeDescription" merge artifacts and code+description run-together (e.g. E08.8Diabetes -> E08.8 Diabetes).
	 * Preserves newlines for line parsing.
	 */
	private normalizeSectionText(text: string): string {
		// Insert space between ICD-10 code and following word when PDF has them run together (e.g. E08.8Diabetes)
		const codeThenWord = new RegExp(
			`(${ExtractorService.ICD10_CODE_ONLY_PATTERN.source})([A-Za-z])`,
			"g"
		);
		return text
			.split("\n")
			.map((line) => {
				let out = line.replace(/\bCodeDescription\b/gi, " ");
				out = out.replace(codeThenWord, "$1 $2");
				return out.replace(/\s+/g, " ").trim();
			})
			.join("\n");
	}

	/**
	 * If code ends with a single letter (stolen from description), return normalized code and prepend letter to description
	 */
	private normalizeCodeAndDescription(code: string, description: string): { code: string; description: string } {
		const trailingSingleLetter = /^([A-Z]\d{2}\.\d{2,4}(?:\d|[A-Z]\d)?)([A-Z])$/;
		const m = code.match(trailingSingleLetter);
		if (m) {
			return { code: m[1], description: m[2] + description };
		}
		return { code, description };
	}

	/**
	 * Repair common missing first letters in descriptions (OCR/regex capture issues)
	 */
	private repairDescriptionFirstLetter(description: string): string {
		const repairs: [RegExp, string][] = [
			[/^\s*iabetes\b/i, "Diabetes"],
			[/^\s*ype\s+/i, "Type "],
			[/^\s*ellitus\b/i, "Mellitus"],
			[/^\s*etabolic\b/i, "Metabolic"],
			[/^\s*ndocrine\b/i, "Endocrine"],
			[/^\s*rug\b/i, "Drug"],
			[/^\s*hemical\b/i, "Chemical"],
			[/^\s*nduced\b/i, "Induced"],
		];
		let out = description.trim();
		for (const [pattern, replacement] of repairs) {
			if (pattern.test(out)) {
				out = out.replace(pattern, replacement);
				break;
			}
		}
		return out;
	}

	/**
	 * Find ICD-10 codes in text that were not captured in the main pass (e.g. merged lines, different formatting)
	 */
	private findMissedCodes(text: string, seenCodes: Set<string>): Array<{ code: string; description: string }> {
		const results: Array<{ code: string; description: string }> = [];
		let match: RegExpExecArray | null;
		const re = new RegExp(ExtractorService.ICD10_CODE_ONLY_PATTERN.source, "g");
		while ((match = re.exec(text)) !== null) {
			const code = match[1];
			if (seenCodes.has(code)) continue;
			// Take following text up to next code or end of line as description
			const after = text.slice(match.index + match[0].length).replace(/^\s+/, "");
			const nextCode = after.match(ExtractorService.ICD10_CODE_ONLY_PATTERN);
			const description = nextCode
				? after.slice(0, after.indexOf(nextCode[1])).trim()
				: after.split("\n")[0].trim();
			results.push({ code, description: description || "" });
			seenCodes.add(code);
		}
		return results;
	}

	/**
	 * Split description at embedded ICD-10 codes (e.g. "... complication E08.8 Diabetes mellitus..." -> main + E08.8 row).
	 * Uses word-boundary matching so codes mid-sentence create new rows.
	 */
	private splitDescriptionAtEmbeddedCodes(
		description: string
	): { mainDescription: string; embedded: Array<{ code: string; description: string }> } {
		const re = new RegExp(ExtractorService.ICD10_EMBEDDED_PATTERN.source, "g");
		const matches: Array<{ code: string; index: number; length: number }> = [];
		let m: RegExpExecArray | null;
		while ((m = re.exec(description)) !== null) {
			matches.push({ code: m[1], index: m.index, length: m[1].length });
		}
		if (matches.length === 0) {
			return { mainDescription: description, embedded: [] };
		}
		const mainDescription = description.slice(0, matches[0].index).trim();
		const embedded: Array<{ code: string; description: string }> = [];
		for (let i = 0; i < matches.length; i++) {
			const start = matches[i].index + matches[i].length;
			const end = i + 1 < matches.length ? matches[i + 1].index : description.length;
			embedded.push({ code: matches[i].code, description: description.slice(start, end).trim() });
		}
		return { mainDescription, embedded };
	}

	/**
	 * Expand one (code, description) into an array of rows, splitting when description contains embedded ICD-10 codes.
	 */
	private expandEmbeddedCodes(
		code: string,
		description: string
	): Array<{ code: string; description: string }> {
		const { mainDescription, embedded } = this.splitDescriptionAtEmbeddedCodes(description);
		const out: Array<{ code: string; description: string }> = [];
		if (mainDescription) {
			out.push({ code, description: mainDescription });
		}
		for (const e of embedded) {
			out.push(...this.expandEmbeddedCodes(e.code, e.description));
		}
		return out;
	}

	/**
	 * Push one or more code rows, splitting description at embedded ICD codes. Only adds codes not already in seenCodes.
	 */
	private pushCodesWithEmbeddedSplit(
		codes: ExtractedCode[],
		seenCodes: Set<string>,
		code: string,
		description: string
	): void {
		const expanded = this.expandEmbeddedCodes(code, description);
		for (const { code: c, description: d } of expanded) {
			if (seenCodes.has(c)) continue;
			codes.push({
				code: c,
				description: d,
				category: this.getCategory(c),
			});
			seenCodes.add(c);
		}
	}

	/**
	 * Calculate confidence score for regex extraction
	 */
	private calculateConfidence(codes: ExtractedCode[], text: string): number {
		if (codes.length === 0) return 0;

		let score = 50; // Base score

		// Check if we found the expected section headers
		if (text.includes("ICD-10-CM Codes that Support Medical Necessity")) {
			score += 20;
		}

		// Check if codes have descriptions
		const codesWithDescriptions = codes.filter((c) => c.description.length > 10);
		const descriptionRatio = codesWithDescriptions.length / codes.length;
		score += Math.round(descriptionRatio * 20);

		// Check for expected diabetes code categories
		const expectedPrefixes = ["E08", "E09", "E10", "E11", "E13", "O24"];
		const foundPrefixes = new Set(codes.map((c) => c.code.substring(0, 3)));
		const prefixOverlap = expectedPrefixes.filter((p) => foundPrefixes.has(p)).length;
		score += Math.round((prefixOverlap / expectedPrefixes.length) * 10);

		return Math.min(100, Math.max(0, score));
	}

	/**
	 * Merge codes from regex and LLM, preferring LLM descriptions
	 */
	private mergeCodes(regexCodes: ExtractedCode[], llmCodes: ExtractedCode[]): ExtractedCode[] {
		const merged = new Map<string, ExtractedCode>();

		// Add regex codes first
		for (const code of regexCodes) {
			merged.set(code.code, code);
		}

		// Overlay LLM codes (may have better descriptions)
		for (const code of llmCodes) {
			if (!merged.has(code.code) || code.description.length > (merged.get(code.code)?.description.length || 0)) {
				merged.set(code.code, {
					...code,
					category: this.getCategory(code.code),
				});
			}
		}

		return Array.from(merged.values()).sort((a, b) => a.code.localeCompare(b.code));
	}

	private extractArticleId(text: string): string {
		const match = text.match(/Article\s*(?:ID)?\s*[:\s]*([A-Z]\d{5})/i);
		return match ? match[1] : "Unknown";
	}

	private extractTitle(text: string): string {
		const match = text.match(/Article\s*Title\s*[:\s]*(.+?)(?:\n|Article\s*Type)/i);
		if (match) {
			return match[1].trim();
		}
		const fallbackMatch = text.match(/(Glucose\s*Monitor[^-\n]*)/i);
		return fallbackMatch ? fallbackMatch[1].trim() : "Policy Document";
	}

	private extractEffectiveDate(text: string): string {
		const patterns = [
			/Revision\s*Effective\s*Date\s*[:\s]*(\d{2}\/\d{2}\/\d{4})/i,
			/Effective\s*Date\s*[:\s]*(\d{2}\/\d{2}\/\d{4})/i,
			/(\d{2}\/\d{2}\/\d{4})/,
		];

		for (const pattern of patterns) {
			const match = text.match(pattern);
			if (match) {
				const [month, day, year] = match[1].split("/");
				return `${year}-${month}-${day}`;
			}
		}

		return new Date().toISOString().split("T")[0];
	}

	private cleanDescription(description: string): string {
		let out = description
			.replace(/\bCodeDescription\b/gi, " ")
			.replace(/[ \t]+/g, " ")
			.replace(/\n\s*\n+/g, "\n")
			.replace(/^[-–—]\s*/, "")
			.trim();
		// Strip leading ICD-10 code if PDF artifact left code+description run together (e.g. E08.8Diabetes mellitus...)
		const leadingCode = out.match(new RegExp(`^(${ExtractorService.ICD10_CODE_ONLY_PATTERN.source})\\s*`));
		if (leadingCode) {
			out = out.slice(leadingCode[0].length).trim();
		}
		return out;
	}

	private isHeaderLine(line: string): boolean {
		const headerPatterns = [
			/^Code\s+Description/i,
			/^Group\s+\d/i,
			/^ICD-10/i,
			/^The presence of/i,
			/^\d+\/\d+\/\d+/,
			/^https?:\/\//,
		];
		return headerPatterns.some((pattern) => pattern.test(line));
	}

	private getCategory(code: string): string {
		const prefix = code.substring(0, 3);
		return this.CATEGORY_MAP[prefix] || "Other";
	}

	/**
	 * Validate ICD-10 code format (no single trailing letter; 7th char is digit or letter+digit)
	 */
	isValidICD10Code(code: string): boolean {
		return /^[A-Z]\d{2}\.\d{2,4}(?:\d|[A-Z]\d)?$/.test(code);
	}
}
