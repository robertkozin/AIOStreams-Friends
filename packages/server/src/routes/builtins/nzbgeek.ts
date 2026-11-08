import { Router, Request, Response, NextFunction } from 'express';
import { fromUrlSafeBase64, NzbgeekAddon } from '@aiostreams/core';
import { rawExtras } from '../../utils/extras.js';

const router: Router = Router();

interface Params {
  encodedConfig: string;
  type: string;
  id: string;
}

const addonOf = (encodedConfig: string) =>
  new NzbgeekAddon(JSON.parse(fromUrlSafeBase64(encodedConfig)));

router.get(
  '/:encodedConfig/manifest.json',
  (
    req: Request<Pick<Params, 'encodedConfig'>>,
    res: Response,
    next: NextFunction
  ) => {
    try {
      res.json(addonOf(req.params.encodedConfig).getManifest());
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/:encodedConfig/catalog/:type/:id{/:extras}.json',
  async (
    req: Request<Params & { extras?: string }>,
    res: Response,
    next: NextFunction
  ) => {
    const { encodedConfig, type, id } = req.params;
    try {
      res.json(
        await addonOf(encodedConfig).getCatalog(type, id, rawExtras(req))
      );
    } catch (error) {
      next(error);
    }
  }
);

export default router;
