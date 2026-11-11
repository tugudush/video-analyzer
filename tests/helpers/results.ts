/**
 * Result-shape helpers shared by the extract_frames tests.
 *
 * `extract_frames` writes into a newly created subfolder per request and
 * reports it as `data.outputDir`, so tests read the folder from the result
 * instead of reconstructing the generated name.
 */

/** Folder an `extract_frames` run wrote into: `data.outputDir`, always absolute. */
export function artifactDirOf(data: unknown): string {
  return (data as { outputDir: string }).outputDir
}
