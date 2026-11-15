// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  { ignores: ["dist-check/*", ".expo/*"] },
  {
    rules: {
      // Screens load their data from Supabase when they open (fetch-on-mount), which this rule
      // reports even though the state updates happen after the network call returns.
      "react-hooks/set-state-in-effect": "off",
    },
  },
]);
