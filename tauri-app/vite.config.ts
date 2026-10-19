import { defineConfig } from 'vitest/config';
export default defineConfig({build:{outDir:'ui',emptyOutDir:true},server:{strictPort:true,proxy:{'/api':'http://127.0.0.1:8787','/health':'http://127.0.0.1:8787'}},test:{environment:'jsdom',setupFiles:['./tests/setup.ts'],restoreMocks:true}});
