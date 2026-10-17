// 洋書リーダー用：Project Gutenberg の本文を取り次ぐ Cloudflare Worker
// 使い方：https://<あなたのworker>.workers.dev/?id=1342 → 『高慢と偏見』のテキストを返す
// 作品番号（数字）しか受け付けないので、ほかのサイトの中継には使えません。
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const id = new URL(request.url).searchParams.get("id") || "";
    if (!/^\d{1,6}$/.test(id)) return new Response("id（作品番号）を指定してください", { status: 400, headers: CORS });

    const candidates = [
      `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`,
      `https://www.gutenberg.org/files/${id}/${id}-0.txt`,
      `https://www.gutenberg.org/files/${id}/${id}.txt`,
    ];
    for (const url of candidates) {
      const res = await fetch(url, {
        headers: { "User-Agent": "gutenberg-reader (personal reading app)" },
        cf: { cacheTtl: 604800, cacheEverything: true },
      });
      if (res.ok) {
        return new Response(res.body, {
          headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=604800" },
        });
      }
    }
    return new Response("本文が見つかりませんでした", { status: 404, headers: CORS });
  },
};
