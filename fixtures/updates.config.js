// Config boundary: loadConfig walks up from the processed file, so without this
// file, tests running on in-repo fixtures would inherit the repo's own
// updates.config.ts. The sibling renovate.json bounds the renovate config
// walk-up the same way. Fixtures with their own config are unaffected
// (nearest wins).
export default {};
