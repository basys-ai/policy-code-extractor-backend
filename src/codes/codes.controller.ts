import { Controller, Get, Query } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiQuery } from "@nestjs/swagger";
import { CodesService, ICD10Code } from "./codes.service";

@ApiTags("codes")
@Controller("codes")
export class CodesController {
	constructor(private readonly codesService: CodesService) {}

	@Get("search")
	@ApiOperation({ summary: "Search ICD-10 codes" })
	@ApiQuery({ name: "query", required: false, description: "Search term" })
	@ApiQuery({ name: "policyId", required: false, description: "Filter by policy ID" })
	@ApiQuery({ name: "category", required: false, description: "Filter by category prefix (e.g., E08, E10)" })
	async search(
		@Query("query") query?: string,
		@Query("policyId") policyId?: string,
		@Query("category") category?: string
	): Promise<ICD10Code[]> {
		return this.codesService.search(query, policyId, category);
	}
}
