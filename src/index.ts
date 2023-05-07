export interface Env {
  // Example binding to KV. Learn more at https://developers.cloudflare.com/workers/runtime-apis/kv/
  // MY_KV_NAMESPACE: KVNamespace;
  //
  // Example binding to Durable Object. Learn more at https://developers.cloudflare.com/workers/runtime-apis/durable-objects/
  // MY_DURABLE_OBJECT: DurableObjectNamespace;
  //
  // Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
  // MY_BUCKET: R2Bucket;
  //
  // Example binding to a Service. Learn more at https://developers.cloudflare.com/workers/runtime-apis/service-bindings/
  // MY_SERVICE: Fetcher;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const [shortcuts, redirects] = await Promise.all([
      searchWiki({ grtn: true }),
      searchWiki({ grtnRedirects: true }),
    ]);
    const pages = [
      ...shortcuts.result.data.results,
      ...redirects.result.data.results,
    ];

    const routes: { from: string; to: string }[] = [];
    for (const page of pages) {
      const pageRef = page.pageRef;

      const shortcut = page.frontMatter?.grtn;
      if (typeof shortcut === "string") {
        routes.push({
          from: shortcut,
          to: wikiUrl(pageRef),
        });
      }

      const redirects = page.frontMatter?.grtnRedirects;
      if (redirects && typeof redirects === "object") {
        for (const [from, to] of Object.entries(redirects)) {
          if (typeof from === "string" && typeof to === "string") {
            routes.push({ from, to });
          }
        }
      }
    }

    return new Response(JSON.stringify(routes, null, 2), {
      headers: {
        "content-type": "application/json;charset=UTF-8",
      },
    });
  },
};

async function searchWiki(query: any) {
  const response = await fetch(
    "https://wiki.creatorsgarten.org/api/contentsgarten/search?" +
      new URLSearchParams({
        input: JSON.stringify({ match: query }),
      }),
    {
      cf: { cacheTtl: 15 },
    }
  );
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json() as any;
}

function wikiUrl(pageRef: string) {
  if (pageRef.startsWith("Events/")) {
    return `https://creatorsgarten.org/event/${pageRef.slice(7)}`;
  }
  return `https://creatorsgarten.org/wiki/${pageRef}`;
}
