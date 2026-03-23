module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'prettier'],
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module'
  },
  env: {
    node: true,
    es2020: true
  },
  ignorePatterns: ['dist', 'node_modules', 'src/audio/vendor/**'],
  rules: {
    '@typescript-eslint/no-unused-vars': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/ban-ts-comment': 'off',
    'no-var': 'off',
    'prefer-const': 'off',
    'no-case-declarations': 'off',
    'no-constant-condition': 'off',
    'no-unsafe-finally': 'off',
    'no-irregular-whitespace': 'off'
  }
};
