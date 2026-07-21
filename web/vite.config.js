import { defineConfig } from 'vite';

// Deployed to GitHub Pages as a PROJECT site, which serves from a subpath
// (https://<user>.github.io/utilities.mc/) rather than the domain root. Without a matching
// `base`, every emitted asset URL is root-absolute and 404s once hosted.
//
// The env override exists so the same build can target a root-served host (Vercel, a custom
// domain, `vite preview`) without editing this file: BASE_PATH=/ npm run build.
//
// Note that `base` does NOT reach the two WASM modules. They are loaded through a runtime
// dynamic import marked `@vite-ignore`, which opts them out of Vite's URL rewriting, so
// src/engine.js applies `import.meta.env.BASE_URL` itself. Changing one without the other
// gives a page that boots in dev and fails only when deployed.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/utilities.mc/',
});
