import { Injectable, Logger } from "@nestjs/common";
import * as ExcelJS from "exceljs";
import {
	Document,
	Packer,
	Paragraph,
	TextRun,
	Table,
	TableRow,
	TableCell,
	WidthType,
	AlignmentType,
	HeadingLevel,
} from "docx";
import { ICD10Code } from "../codes/codes.service";
import { Policy } from "./policies.service";

@Injectable()
export class ExportService {
	private readonly logger = new Logger(ExportService.name);

	/** ICD-10 pattern at start of string (for cleaning description artifacts in export). */
	private static readonly LEADING_ICD10 = /^[A-Z]\d{2}\.\d{2,4}(?:\d|[A-Z]\d)?\s*/;

	/** Deduplicate by code so export always has one row per code (safety net for any upstream duplicates). */
	private uniqueCodesByCode(codes: ICD10Code[]): ICD10Code[] {
		const seen = new Map<string, ICD10Code>();
		for (const c of codes) {
			if (!seen.has(c.code)) seen.set(c.code, c);
		}
		return Array.from(seen.values()).sort((a, b) => a.code.localeCompare(b.code));
	}

	/** Strip leading ICD-10 code from description if present (fixes code+description run-together in DOCX/Excel). */
	private descriptionForExport(description: string): string {
		if (!description || typeof description !== "string") return description;
		return description.replace(ExportService.LEADING_ICD10, "").trim() || description;
	}

	async exportToExcel(policy: Policy, codes: ICD10Code[]): Promise<Buffer> {
		const unique = this.uniqueCodesByCode(codes);
		if (unique.length !== codes.length) {
			this.logger.log(`Export deduplicated codes: ${codes.length} -> ${unique.length}`);
		}
		this.logger.log(`Exporting ${unique.length} codes to Excel...`);

		const workbook = new ExcelJS.Workbook();
		workbook.creator = "Policy Code Extractor";
		workbook.created = new Date();

		const worksheet = workbook.addWorksheet("ICD-10 Codes");

		// Add title
		worksheet.mergeCells("A1:C1");
		const titleCell = worksheet.getCell("A1");
		titleCell.value = `${policy.title} (${policy.articleId})`;
		titleCell.font = { size: 16, bold: true };
		titleCell.alignment = { horizontal: "center" };

		// Add metadata (Article ID and Effective Date for policy-aware / PA logic)
		worksheet.mergeCells("A2:C2");
		const metaCell = worksheet.getCell("A2");
		metaCell.value = `Article ID: ${policy.articleId} | Effective Date: ${policy.effectiveDate} | Total Codes: ${unique.length} | Extraction: ${policy.extractionMethod || "regex"} (${policy.confidence || 0}% confidence)`;
		metaCell.font = { size: 11, italic: true };
		metaCell.alignment = { horizontal: "center" };

		// Empty row
		worksheet.addRow([]);

		// Add headers
		const headerRow = worksheet.addRow(["Code", "Description", "Category"]);
		headerRow.font = { bold: true };
		headerRow.eachCell((cell) => {
			cell.fill = {
				type: "pattern",
				pattern: "solid",
				fgColor: { argb: "FF1E3A5F" },
			};
			cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
			cell.border = {
				top: { style: "thin" },
				left: { style: "thin" },
				bottom: { style: "thin" },
				right: { style: "thin" },
			};
		});

		// Add data rows (use unique list; clean description for display)
		unique.forEach((code, index) => {
			const row = worksheet.addRow([
				code.code,
				this.descriptionForExport(code.description),
				code.category,
			]);

			if (index % 2 === 0) {
				row.eachCell((cell) => {
					cell.fill = {
						type: "pattern",
						pattern: "solid",
						fgColor: { argb: "FFF5F5F5" },
					};
				});
			}

			row.eachCell((cell) => {
				cell.border = {
					top: { style: "thin", color: { argb: "FFE0E0E0" } },
					left: { style: "thin", color: { argb: "FFE0E0E0" } },
					bottom: { style: "thin", color: { argb: "FFE0E0E0" } },
					right: { style: "thin", color: { argb: "FFE0E0E0" } },
				};
			});
		});

		// Set column widths
		worksheet.getColumn(1).width = 15;
		worksheet.getColumn(2).width = 80;
		worksheet.getColumn(3).width = 35;

		const buffer = await workbook.xlsx.writeBuffer();
		return Buffer.from(buffer);
	}

	async exportToDocx(policy: Policy, codes: ICD10Code[]): Promise<Buffer> {
		const unique = this.uniqueCodesByCode(codes);
		if (unique.length !== codes.length) {
			this.logger.log(`Export deduplicated codes: ${codes.length} -> ${unique.length}`);
		}
		this.logger.log(`Exporting ${unique.length} codes to Word...`);

		// Group codes by category
		const codesByCategory = unique.reduce((acc, code) => {
			const category = code.code.substring(0, 3);
			if (!acc[category]) {
				acc[category] = [];
			}
			acc[category].push(code);
			return acc;
		}, {} as Record<string, ICD10Code[]>);

		const categoryNames: Record<string, string> = {
			E08: "Diabetes due to underlying condition",
			E09: "Drug or chemical induced diabetes",
			E10: "Type 1 diabetes mellitus",
			E11: "Type 2 diabetes mellitus",
			E13: "Other specified diabetes mellitus",
			O24: "Diabetes mellitus in pregnancy",
		};

		const children: any[] = [
			new Paragraph({
				text: policy.title,
				heading: HeadingLevel.HEADING_1,
				spacing: { after: 200 },
			}),
			new Paragraph({
				children: [
					new TextRun({ text: `Article ID: ${policy.articleId}`, bold: true }),
					new TextRun({ text: `  |  Effective Date: ${policy.effectiveDate}`, bold: true }),
					new TextRun({ text: `  |  Total Codes: ${unique.length}` }),
				],
				spacing: { after: 200 },
			}),
			new Paragraph({
				children: [
					new TextRun({
						text: `Extraction Method: ${policy.extractionMethod || "regex"} (${policy.confidence || 0}% confidence)`,
						italics: true,
					}),
				],
				spacing: { after: 400 },
			}),
		];

		for (const [category, categoryCodes] of Object.entries(codesByCategory)) {
			children.push(
				new Paragraph({
					text: `${category} - ${categoryNames[category] || "Other"}`,
					heading: HeadingLevel.HEADING_2,
					spacing: { before: 400, after: 200 },
				})
			);

			const tableRows = [
				new TableRow({
					children: [
						new TableCell({
							children: [
								new Paragraph({ text: "Code", alignment: AlignmentType.CENTER }),
							],
							width: { size: 15, type: WidthType.PERCENTAGE },
							shading: { fill: "1E3A5F" },
						}),
						new TableCell({
							children: [new Paragraph({ text: "Description" })],
							width: { size: 85, type: WidthType.PERCENTAGE },
							shading: { fill: "1E3A5F" },
						}),
					],
				}),
			];

			categoryCodes.forEach((code) => {
				const descText = this.descriptionForExport(code.description || "");
				tableRows.push(
					new TableRow({
						children: [
							new TableCell({
								children: [
									new Paragraph({
										children: [new TextRun({ text: code.code, font: "Courier New" })],
									}),
								],
							}),
							new TableCell({
								children: (() => {
									const lines = descText
										.split("\n")
										.map((s) => s.trim())
										.filter((s) => s.length > 0);
									return lines.length > 0
										? lines.map((line) => new Paragraph({ text: line }))
										: [new Paragraph({ text: "—" })];
								})(),
							}),
						],
					})
				);
			});

			children.push(
				new Table({
					rows: tableRows,
					width: { size: 100, type: WidthType.PERCENTAGE },
				})
			);
		}

		const doc = new Document({
			sections: [
				{
					properties: {
						page: {
							margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
						},
					},
					children,
				},
			],
		});

		return await Packer.toBuffer(doc);
	}
}
