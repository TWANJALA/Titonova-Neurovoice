import { fileURLToPath, URL } from "node:url";
import { defineConfig, loadEnv } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { stripeBillingApiPlugin } from "./server/stripeBillingApiPlugin";
import { translateApiPlugin } from "./server/translateApiPlugin";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [tailwindcss(), translateApiPlugin(env), stripeBillingApiPlugin(env)],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
  };
});
