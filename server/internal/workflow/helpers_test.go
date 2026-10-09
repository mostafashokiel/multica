package workflow

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func readFile(t *testing.T, path ...string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(append([]string{"testdata"}, path...)...))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func mustParse(t *testing.T, src []byte) *Definition {
	t.Helper()
	def, issues := Parse(src)
	if len(issues) > 0 {
		t.Fatalf("unexpected parse issues: %+v", issues)
	}
	return def
}

func fixture(t *testing.T, name string) *Definition {
	t.Helper()
	return mustParse(t, readFile(t, "fixtures", name+".yaml"))
}

func codes(issues []Issue) []string {
	seen := map[string]bool{}
	var out []string
	for _, i := range issues {
		if !seen[i.Code] {
			seen[i.Code] = true
			out = append(out, i.Code)
		}
	}
	sort.Strings(out)
	return out
}

func hasMessage(issues []Issue, part string) bool {
	for _, i := range issues {
		if strings.Contains(i.Message, part) || strings.Contains(i.Path, part) {
			return true
		}
	}
	return false
}

func readFileNoT(path string) []byte {
	b, err := os.ReadFile(path)
	if err != nil {
		panic(err)
	}
	return b
}
