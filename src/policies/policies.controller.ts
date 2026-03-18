import {
	Controller,
	Get,
	Post,
	Delete,
	Param,
	Res,
	Query,
	UseInterceptors,
	UploadedFile,
	HttpStatus,
	ParseFilePipe,
	MaxFileSizeValidator,
	FileTypeValidator,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Response } from "express";
import {
	ApiTags,
	ApiOperation,
	ApiConsumes,
	ApiBody,
	ApiParam,
	ApiQuery,
	ApiResponse,
} from "@nestjs/swagger";
import { PoliciesService, Policy, PolicyWithCodes } from "./policies.service";
import { ExportService } from "./export.service";

@ApiTags("policies")
@Controller("policies")
export class PoliciesController {
	constructor(
		private readonly policiesService: PoliciesService,
		private readonly exportService: ExportService
	) {}

	@Post("upload")
	@ApiOperation({ summary: "Upload a policy PDF and extract ICD-10 codes" })
	@ApiConsumes("multipart/form-data")
	@ApiBody({
		schema: {
			type: "object",
			properties: {
				file: {
					type: "string",
					format: "binary",
					description: "PDF file to upload",
				},
			},
		},
	})
	@ApiQuery({
		name: "async",
		required: false,
		description: "Process asynchronously (queue job)",
	})
	@ApiQuery({
		name: "provider",
		required: false,
		description: "Extraction provider: regex, openai, or gemini",
	})
	@ApiQuery({
		name: "temperature",
		required: false,
		description: "LLM temperature 0-1 (only when provider is openai or gemini)",
	})
	@ApiResponse({ status: 201, description: "Policy created successfully" })
	@UseInterceptors(FileInterceptor("file"))
	async uploadPolicy(
		@UploadedFile(
			new ParseFilePipe({
				validators: [
					new MaxFileSizeValidator({ maxSize: 50 * 1024 * 1024 }), // 50MB
					new FileTypeValidator({ fileType: "application/pdf" }),
				],
			})
		)
		file: Express.Multer.File,
		@Query("async") asyncMode?: string,
		@Query("provider") provider?: string,
		@Query("temperature") temperature?: string
	) {
		const isAsync = asyncMode === "true" || asyncMode === "1";
		const temp = temperature != null ? parseFloat(temperature) : undefined;
		const result = await this.policiesService.processUpload(
			file.buffer,
			file.originalname,
			isAsync,
			{ provider, temperature: temp }
		);

		return {
			policy: result.policy,
			codes: result.codes,
			extractedCount: result.codes?.length || 0,
			async: isAsync,
		};
	}

	@Get()
	@ApiOperation({ summary: "Get all policies" })
	async findAll(): Promise<Policy[]> {
		return this.policiesService.findAll();
	}

	@Get(":id")
	@ApiOperation({ summary: "Get a policy by ID with all codes" })
	@ApiParam({ name: "id", description: "Policy ID" })
	async findById(@Param("id") id: string): Promise<PolicyWithCodes> {
		return this.policiesService.findByIdWithCodes(id);
	}

	@Delete(":id")
	@ApiOperation({ summary: "Delete a policy and its codes" })
	@ApiParam({ name: "id", description: "Policy ID" })
	@ApiResponse({ status: 204, description: "Policy deleted successfully" })
	async delete(@Param("id") id: string, @Res() res: Response) {
		await this.policiesService.delete(id);
		return res.status(HttpStatus.NO_CONTENT).send();
	}

	@Get(":id/export/excel")
	@ApiOperation({ summary: "Export policy codes to Excel" })
	@ApiParam({ name: "id", description: "Policy ID" })
	async exportToExcel(@Param("id") id: string, @Res() res: Response) {
		const policy = await this.policiesService.findByIdWithCodes(id);
		const buffer = await this.exportService.exportToExcel(policy, policy.codes);

		res.set({
			"Content-Type":
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			"Content-Disposition": `attachment; filename="${policy.articleId}_codes.xlsx"`,
			"Content-Length": buffer.length,
		});

		return res.send(buffer);
	}

	@Get(":id/export/docx")
	@ApiOperation({ summary: "Export policy codes to Word document" })
	@ApiParam({ name: "id", description: "Policy ID" })
	async exportToDocx(@Param("id") id: string, @Res() res: Response) {
		const policy = await this.policiesService.findByIdWithCodes(id);
		const buffer = await this.exportService.exportToDocx(policy, policy.codes);

		res.set({
			"Content-Type":
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			"Content-Disposition": `attachment; filename="${policy.articleId}_codes.docx"`,
			"Content-Length": buffer.length,
		});

		return res.send(buffer);
	}
}
