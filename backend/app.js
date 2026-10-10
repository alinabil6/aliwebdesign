import express from 'express';
import compression from 'compression';
import path from 'path';
import { fileURLToPath } from 'url';
import accountsRouter from './routes/accounts.js';
import variationsRouter from './routes/variations.js';
import designToDesignRouter from './routes/designToDesign.js';
import artStyleNicheRouter from './routes/artStyleNiche.js';
import textToImageRouter from './routes/textToImage.js';
import pixelToPixelRouter from './routes/pixelToPixel.js';
import prepareDesignsRouter from './routes/prepareDesigns.js';
import editRouter from './routes/edit.js';
import designsRouter from './routes/designs.js';
import stylesRouter from './routes/styles.js';
import magicListingRouter from './routes/magicListing.js';
import cancelRouter from './routes/cancel.js';
import { authenticateRequest } from './middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

export function createApp() {
  const app = express();

  app.use(compression());
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));
  app.use(express.static(path.join(ROOT, 'frontend')));
  app.use('/library', express.static(path.join(ROOT, 'library')));
  app.use('/vendor/lucide', express.static(path.join(ROOT, 'node_modules', 'lucide', 'dist')));

  app.use((req, res, next) => {
    try {
      const decoded = decodeURIComponent(req.path);
      if (decoded.includes('..') || decoded.includes('\0')) {
        return res.status(400).json({ error: 'Bad request' });
      }
    } catch {
      return res.status(400).json({ error: 'Bad request' });
    }
    next();
  });

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, name: 'aliwebdesign', time: new Date().toISOString() });
  });

  const generateAuth = authenticateRequest({ anyOfScopes: ['ai.generate:run'] });
  const stylesAuth = authenticateRequest({ anyOfScopes: ['ai.styles:analyze'] });
  const listingAuth = authenticateRequest({ anyOfScopes: ['ai.listing:generate'] });

  app.use('/api/accounts', accountsRouter);
  app.use('/api/generate', generateAuth, variationsRouter);
  app.use('/api/generate', generateAuth, designToDesignRouter);
  app.use('/api/generate', generateAuth, artStyleNicheRouter);
  app.use('/api/generate', generateAuth, textToImageRouter);
  app.use('/api/generate', generateAuth, pixelToPixelRouter);
  app.use('/api/generate', generateAuth, cancelRouter);
  app.use('/api/prepare-designs', prepareDesignsRouter);
  app.use('/api/edit', editRouter);
  app.use('/api/designs', designsRouter);
  app.use('/api/styles', stylesAuth, stylesRouter);
  app.use('/api/magic-listing', listingAuth, magicListingRouter);

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err, req, res, next) => {
    console.error(`[error] ${req.method} ${req.originalUrl}:`, err);
    res.status(err.status || 500).json({ error: 'Internal server error' });
  });

  return app;
}
