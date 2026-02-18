module example.com/test

go 1.24

require github.com/google/uuid v1.5.0

require (
  github.com/google/uuid v1.5.0
)

require (
  github.com/google/uuid v1.5.0
)

require (
  github.com/google/go-github/v70 v70.0.0
  github.com/google/uuid v1.5.0
)

replace github.com/google/uuid => github.com/custom/uuid v0.0.0-20240101000000-abcdef123456

replace (
  github.com/google/go-github/v70 => github.com/custom/go-github v0.0.0-20240101000000-abcdef123456
)
