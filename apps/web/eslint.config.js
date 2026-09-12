const { FlatCompat } = require("@eslint/eslintrc");

const compat = new FlatCompat({ baseDirectory: __dirname });

module.exports = [{ ignores: [".next/**"] }, ...compat.extends("eslint-config-next/core-web-vitals")];
