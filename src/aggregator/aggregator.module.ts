import { Module } from "@nestjs/common";
import { AggregatorService } from "./aggregator.service.ts";

@Module({
  providers: [AggregatorService],
  exports: [AggregatorService],
})
export class AggregatorModule {}
