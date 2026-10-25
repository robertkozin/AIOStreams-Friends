import { Router, Request, Response, NextFunction } from 'express';
import { APIError, constants, createLogger } from '@aiostreams/core';
import { ZodError } from 'zod';
import {
  resolvePlaybackChain,
  type PlaybackParams,
} from '../../utils/playback.js';
import { corsMiddleware } from '../../middlewares/cors.js';
const router: Router = Router();
const logger = createLogger('server');

router.use(corsMiddleware);

// block HEAD requests
router.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method === 'HEAD') {
    res.status(405).send('Method not allowed');
  } else {
    next();
  }
});

router.get(
  [
    '/playback/:encryptedStoreAuth/:fallbackKey/:fileInfo/:metadataId/:filename',
    // Legacy
    '/playback/:encryptedStoreAuth/:fileInfo/:metadataId/:filename',
  ],
  async (req: Request<PlaybackParams>, res: Response, next: NextFunction) => {
    try {
      const outcome = await resolvePlaybackChain({
        ...req.params,
        clientIp: req.userIp,
        arrivedViaOurProxy: !!req.query[constants.INTERNAL_PROXY_MARKER],
        playPath:
          req.query[constants.PLAY_PATH_MARKER] === 'jellyfin'
            ? 'jellyfin'
            : 'stremio',
      });
      if ('badRequest' in outcome) {
        next(
          new APIError(
            constants.ErrorCode.BAD_REQUEST,
            undefined,
            outcome.badRequest
          )
        );
        return;
      }
      if ('staticFile' in outcome) {
        res.redirect(307, `/static/${outcome.staticFile}`);
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(307, outcome.url);
      outcome.played();
    } catch (error: any) {
      if (error instanceof APIError || error instanceof ZodError) {
        next(error);
      } else {
        logger.error(
          { err: error },
          `got unexpected error during debrid resolve: ${error.message}`
        );
        next(
          new APIError(
            constants.ErrorCode.INTERNAL_SERVER_ERROR,
            undefined,
            error.message
          )
        );
      }
    }
  }
);

export default router;
