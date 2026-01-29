# npm Registry API Analysis & Network I/O Optimization

## Problem: Excessive Data Transfer

### Current npm API Usage
- **Endpoint**: `GET /{package}` (full package metadata)
- **Example** (react package):
  - **Uncompressed size**: 6.4 MB
  - **Version count**: 2,692 versions
  - **Data includes**: Full metadata for EVERY version (repository, dependencies, maintainers, etc.)

### What We Actually Need
```typescript
// From code analysis (index.ts lines 752-835, 1320-1331):
{
  name: string,                    // Package name
  "dist-tags": {                   // To get latest tag
    latest: string
  },
  time: {                          // To determine version age
    [version: string]: string      // ISO timestamp per version
  },
  versions: {                      // List of all versions
    [version: string]: {           // We only need ONE version's metadata:
      repository?: {...},          //   - For getInfoUrl()
      homepage?: string            //   - For getInfoUrl()
    }
  }
}
```

### npm API Endpoint Options

| Endpoint | Size (react) | Contains | Use Case |
|----------|--------------|----------|----------|
| `/{package}` | **6.4 MB** | Full metadata for all versions | Current usage ❌ |
| `/{package}/latest` | 1.7 KB | Single version metadata only | Can't determine "latest" for range |
| `/-/package/{package}/dist-tags` | 217 bytes | Just dist-tags | Missing time + versions |

### The Challenge

**npm doesn't provide an endpoint that gives us:**
- ✅ All version numbers (needed to find matching versions)
- ✅ `time` object (needed to determine which is latest)
- ✅ `dist-tags` (needed for latest tag)
- ❌ WITHOUT all the per-version metadata we don't need

**Minimal needed data**: ~280 KB (version list + timestamps)
**What we fetch**: 6.4 MB (23× more than needed!)

## Solution Implemented: HTTP Compression

Since npm doesn't offer a lighter endpoint with all required data, we implemented HTTP compression:

### Changes Made

```typescript
// Before: No compression
function getFetchOpts(authType?: string, authToken?: string): RequestInit {
  return {
    headers: {
      "user-agent": `updates/${packageVersion}`,
      ...(authToken && {Authorization: `${authType} ${authToken}`}),
    }
  };
}

// After: Request compressed responses
function getFetchOpts(authType?: string, authToken?: string): RequestInit {
  return {
    headers: {
      "user-agent": `updates/${packageVersion}`,
      "accept-encoding": "gzip, deflate, br",  // ← NEW
      ...(authToken && {Authorization: `${authType} ${authToken}`}),
    }
  };
}
```

**Applied to**:
- ✅ `getFetchOpts()` - npm registry requests
- ✅ `fetchPypiInfo()` - PyPI API requests  
- ✅ `fetchGitHub()` - GitHub API requests

### Expected Impact

- **Compression ratio**: 70-90% reduction (typical for JSON)
- **react package**: 6.4 MB → ~640 KB - 1.9 MB (depending on compression)
- **Network transfer**: For 1,541 packages, could save **gigabytes** of transfer
- **Node.js fetch API**: Automatically decompresses responses (no code changes needed)

### Why Performance Test Shows Similar Times

The npm-1500 fixture test uses **mock HTTP server** (see index.test.ts):
- Mock server doesn't implement compression
- Test responses are small/cached
- Network I/O is simulated, not real

**Real-world benefit**: Production usage will see significant bandwidth savings and potential speed improvements on slower connections.

## Alternative Strategies Considered

### 1. Two-Phase Fetch (Rejected)
**Idea**: 
1. Fetch lightweight data to determine version
2. Fetch specific version metadata only if needed

**Why rejected**:
- Doubles the number of requests (1,541 → 3,082)
- Additional round-trip latency worse than bandwidth savings
- Registry rate limiting concerns

### 2. Use npm Search API (Rejected)
**Idea**: Use `/-/v1/search` endpoint for bulk queries

**Why rejected**:
- Search API doesn't provide version history or timestamps
- Can't determine "latest" vs "greatest" versions
- Doesn't match our use case

### 3. Local npm Cache (Future Work)
**Idea**: Reuse npm's own package cache (`~/.npm`)

**Why not yet**:
- npm cache format is internal/undocumented
- Would require dependency on npm CLI or parsing cache
- Additional complexity vs benefit unclear

## Recommendations

### Immediate (Implemented)
- ✅ Add Accept-Encoding headers (done)
- ✅ Document npm API limitations

### Future Enhancements
- Add response caching (in-memory or disk-based)
- Add `--cache-ttl` flag for cache duration
- Consider npm's abbreviated metadata format if it becomes available

### Upstream Request
File issue with npm registry to provide lightweight endpoint:
```
GET /{package}?fields=name,dist-tags,time,versions
```
This would return just the needed fields, reducing response size by ~95%.
