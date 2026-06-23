import { Controller, Get, Param, Query } from '@nestjs/common';
import { statusRollup, StatusCount } from './status-rollup';

@Controller('sites')
export class StatusController {
  @Get(':siteId/status-rollup')
  async rollup(
    @Param('siteId') siteId: string,
    @Query('stalenessSeconds') stalenessStr?: string,
  ): Promise<StatusCount[]> {
    const staleness = stalenessStr ? parseInt(stalenessStr, 10) : 60;
    return statusRollup(siteId, staleness);
  }
}
