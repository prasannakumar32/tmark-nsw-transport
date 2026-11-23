const path = require("node:path");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const webpack = require("webpack");

module.exports = (_env, argv) => {
  const apiBaseUrl = process.env.API_BASE_URL;

  if (argv.mode === "production" && apiBaseUrl === undefined) {
    throw new Error("API_BASE_URL must be set for production builds.");
  }

  return {
    entry: "./src/main.jsx",
    devtool: argv.mode === "development" ? "source-map" : false,
    output: {
      path: path.resolve(__dirname, "dist"),
      filename: "assets/[name].[contenthash].js",
      clean: true,
    },
    module: {
      rules: [
        {
          test: /\.jsx?$/,
          exclude: /node_modules/,
          use: {
            loader: "babel-loader",
            options: {
              presets: [["@babel/preset-react", { runtime: "automatic" }]],
            },
          },
        },
        {
          test: /\.css$/,
          use: ["style-loader", "css-loader"],
        },
      ],
    },
    resolve: {
      extensions: [".js", ".jsx"],
    },
    plugins: [
      new webpack.DefinePlugin({
        "process.env.API_BASE_URL": JSON.stringify(apiBaseUrl ?? "http://localhost:4000"),
      }),
      new HtmlWebpackPlugin({
        template: "./index.html",
      }),
    ],
  };
};
