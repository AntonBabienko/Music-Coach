"use client";

import dynamic from "next/dynamic";

// The real page uses browser-only APIs (WebAudio, MediaRecorder, OSMD) so SSR
// is unnecessary and causes hydration mismatches when browser extensions inject
// attributes (e.g. fdprocessedid from password managers) before React hydrates.
const Page = dynamic(() => import("./_page"), { ssr: false });

export default function PageWrapper() {
  return <Page />;
}
