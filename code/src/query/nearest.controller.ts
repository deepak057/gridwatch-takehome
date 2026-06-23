import { Controller, Get, Query, Res } from '@nestjs/common';
import { nearestAvailableCharger } from './nearest';

@Controller('chargers')
export class NearestController {
  @Get('nearest')
  async nearest(
    @Query('lat') latStr: string,
    @Query('lng') lngStr: string,
    @Res() res: any,
  ): Promise<void> {
    const lat = parseFloat(latStr);
    const lng = parseFloat(lngStr);

    if (isNaN(lat) || isNaN(lng)) {
      res.status(400).json({ error: 'lat and lng query parameters are required' });
      return;
    }

    const result = await nearestAvailableCharger(lat, lng);

    if (!result) {
      res.status(404).json({ error: 'No available charger found' });
      return;
    }

    res.status(200).json(result);
  }
}
