// Type-checking shim so `npm run typecheck:functions` works with plain tsc
// (Deno is not required locally). The Supabase Edge Runtime provides the real Deno.
declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): void
  env: { get(key: string): string | undefined }
}
