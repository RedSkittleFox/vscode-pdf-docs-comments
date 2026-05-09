#include <iostream>

// Relative (to workspace root) PDF path with full section name 
// @pdf(docs/gcc-manual.pdf#outline=2 Language Standards Supported by GCC > C Language)

// Relative (to workspace root) PDF path with short section name 
// @pdf(docs/gcc-manual.pdf#outline=C++ Language)

// Relative (to workspace root) PDF path with short section name 
// @pdf(docs/gcc-manual.pdf#C++ Language)

// Relative (to workspace root) PDF path with page number
// @pdf(docs/gcc-manual.pdf#page=10)

// Absolute PDF path with page number
// @pdf(/workspaces/vscode-pdf-docs/test-workspace/docs/gcc-manual.pdf#outline=6 Extensions to the C Language Family > Locally Declared Labels)

int main() {
    std::cout << "Hello, World!" << std::endl;
    return 0;
}
