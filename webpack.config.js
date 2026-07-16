const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = (env, argv) => {
  const isProd = argv.mode === 'production';

  return {
    entry: {
      popup: './src/popup/index.tsx',
      options: './src/options/index.tsx',
      content: './src/content/index.ts',
      background: './src/background/index.ts',
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      clean: true,
      // Ensure each entry is fully self-contained (no shared chunks)
      // This is CRITICAL for Chrome extensions: content scripts and background
      // workers cannot load additional JS chunks at runtime
    },
    resolve: {
      extensions: ['.ts', '.tsx', '.js', '.jsx'],
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: 'ts-loader',
          exclude: /node_modules/,
        },
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader'],
        },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: './public/popup.html',
        filename: 'popup.html',
        chunks: ['popup'],
      }),
      new HtmlWebpackPlugin({
        template: './public/options.html',
        filename: 'options.html',
        chunks: ['options'],
      }),
      new CopyWebpackPlugin({
        patterns: [
          { from: 'public/manifest.json', to: 'manifest.json' },
          { from: 'public/icons', to: 'icons', noErrorOnMissing: true },
        ],
      }),
    ],
    devtool: isProd ? false : 'cheap-module-source-map',
    optimization: {
      minimize: isProd,
      // CRITICAL: Disable ALL code splitting for Chrome extensions
      splitChunks: false,
      runtimeChunk: false,
      // Ensure each entry bundle is completely independent
      usedExports: false,
      sideEffects: false,
    },
  };
};
