# Native MDX harness (dev-only). Builds the repo's mdxmini as a normal Linux
# binary and links small drivers, so the engine's loop-region logic can be run
# without Emscripten -- the JS harnesses in dev/ fake the region getters and
# never reach the C. See README.md.
#
#   make -C dev/mdx-native region    -> ./region
#   make -C dev/mdx-native check     -> golden fixtures under catalog/mdx (if present)
#   make -C dev/mdx-native scan-tracks MDXTOOLS_DIR=/path/to/mdxtools   (optional)

CC     ?= cc
ROOT   := ../..
MDXSRC := $(ROOT)/mdxmini/src

MDX_C := $(MDXSRC)/mdx2151.c $(MDXSRC)/mdxfile.c $(MDXSRC)/mdxmini.c \
         $(MDXSRC)/mdxmml_ym2151.c $(MDXSRC)/pcm8.c $(MDXSRC)/pdxfile.c \
         $(MDXSRC)/ym2151.c

# -I. first: mdxmini/src/mdxmini.c includes <emscripten.h> unconditionally, and
# the stub in this directory satisfies it for a native build.
CFLAGS := -O2 -Wall -Wno-unknown-pragmas -I. -I$(MDXSRC)

MDXTOOLS_DIR ?= /tmp/mdxtools

all: region

# nlg.c ships a demo main(); rename it so it does not collide with ours.
nlg.o: $(MDXSRC)/nlg.c
	$(CC) $(CFLAGS) -Dmain=mdx_nlg_demo_unused -c $< -o $@

region: region.c $(MDX_C) nlg.o
	$(CC) $(CFLAGS) -o $@ region.c $(MDX_C) nlg.o -lm

# Optional triage tool; needs a mdxtools checkout. Built without -I$(MDXSRC)
# because mdxtools and mdxmini both ship an mdx.h.
scan-tracks: scan-tracks.c
	$(CC) -O2 -Wall -I. -I$(MDXTOOLS_DIR) -o $@ scan-tracks.c \
	  $(MDXTOOLS_DIR)/mdx.c $(MDXTOOLS_DIR)/tools.c

check: region
	./check.sh

clean:
	rm -f region scan-tracks nlg.o

.PHONY: all check clean
