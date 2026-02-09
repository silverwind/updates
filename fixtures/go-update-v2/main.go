package main

import (
	"fmt"

	"github.com/example/testpkg"
	"github.com/example/testpkg/sub"
)

func main() {
	fmt.Println(testpkg.Hello(), sub.World())
}
