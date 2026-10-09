import Fastify from 'fastify';
import { registerWebBotAuthRoutes } from '/home/claude-dev/projects/portfolio/projects/patch/packages/server/src/web-bot-auth-routes.ts';
const app = Fastify();
registerWebBotAuthRoutes(app, { keyB64: process.env.PATCH_WEB_BOT_AUTH_KEY });
await app.listen({ port: 18931, host: '127.0.0.1' });
console.log('up');
