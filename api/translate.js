import { createTranslateMiddleware } from "../server/translateApiPlugin.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

const translateMiddleware = createTranslateMiddleware(process.env);

export default async function handler(req, res) {
  return translateMiddleware(req, res, () => {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Translate endpoint not found" }));
  });
}
