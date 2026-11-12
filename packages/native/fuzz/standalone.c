/* The libFuzzer-less driver: replays every file of a corpus folder through LLVMFuzzerTestOneInput, then
 * runs a seeded mutation loop over the corpus. Built with ASan and UBSan by fuzz.mjs --smoke, so it runs
 * every harness under the sanitizers wherever libFuzzer does not link (Apple's command-line clang).
 *
 *   standalone <corpus dir> [-runs N] [-seed S] [-crash_dir D] [-slate_fips_config F -slate_fips_modules M]
 *
 * Each input is copied into a malloc of exactly its length, so a read one byte past the end traps. When a
 * sanitizer stops the run, the input that did it is written to <crash_dir>/crash-<round> (a death
 * callback), ready to become a corpus file. */
#include <dirent.h>
#include <sanitizer/common_interface_defs.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

int LLVMFuzzerInitialize(int *argc, char ***argv);
int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size);

#define MAX_INPUT ((size_t)64 * 1024) /* the committed corpus cap (fuzzing plan §2.4) */
#define MAX_CORPUS 4096

typedef struct {
  uint8_t *bytes;
  size_t len;
  char name[256];
} input_t;

static int by_name(const void *a, const void *b) { return strcmp(((const input_t *)a)->name, ((const input_t *)b)->name); }

static input_t g_corpus[MAX_CORPUS];
static size_t g_count;
static const uint8_t *g_current;
static size_t g_current_len;
static long g_round = -1;
static const char *g_crash_dir = ".";

static void on_death(void) {
  if (g_current == NULL) return;
  char path[4096];
  snprintf(path, sizeof path, "%s/crash-%s%ld", g_crash_dir, g_round < 0 ? "replay-" : "", g_round < 0 ? -g_round - 1 : g_round);
  FILE *f = fopen(path, "wb");
  if (f == NULL) return;
  fwrite(g_current, 1, g_current_len, f);
  fclose(f);
  fprintf(stderr, "standalone: the input is in %s (%zu bytes)\n", path, g_current_len);
}

static uint32_t g_state;
/* mulberry32: small, seedable, the same sequence on every OS. */
static uint32_t next_u32(void) {
  uint32_t z = (g_state += 0x6d2b79f5u);
  z = (z ^ (z >> 15)) * (z | 1u);
  z ^= z + (z ^ (z >> 7)) * (z | 61u);
  return z ^ (z >> 14);
}
static size_t below(size_t n) { return n == 0 ? 0 : (size_t)next_u32() % n; }

static void run_one(const uint8_t *src, size_t len) {
  uint8_t *exact = malloc(len);
  if (exact == NULL && len > 0) abort();
  if (len > 0) memcpy(exact, src, len);
  g_current = exact;
  g_current_len = len;
  LLVMFuzzerTestOneInput(exact, len);
  g_current = NULL;
  free(exact);
}

static void load(const char *dir) {
  DIR *d = opendir(dir);
  if (d == NULL) {
    fprintf(stderr, "standalone: cannot open corpus %s\n", dir);
    exit(1);
  }
  struct dirent *e;
  while ((e = readdir(d)) != NULL && g_count < MAX_CORPUS) {
    if (e->d_name[0] == '.') continue;
    char path[4096];
    snprintf(path, sizeof path, "%s/%s", dir, e->d_name);
    struct stat st;
    if (stat(path, &st) != 0 || !S_ISREG(st.st_mode) || (size_t)st.st_size > MAX_INPUT) continue;
    FILE *f = fopen(path, "rb");
    if (f == NULL) continue;
    size_t n = (size_t)st.st_size;
    uint8_t *b = malloc(n == 0 ? 1 : n);
    if (b == NULL || fread(b, 1, n, f) != n) abort();
    fclose(f);
    g_corpus[g_count].bytes = b;
    g_corpus[g_count].len = n;
    snprintf(g_corpus[g_count].name, sizeof g_corpus[g_count].name, "%s", e->d_name);
    g_count++;
  }
  closedir(d);
  /* readdir order differs between filesystems; the mutator indexes the corpus, so a seed reproduces only
   * if the order is fixed. */
  qsort(g_corpus, g_count, sizeof g_corpus[0], by_name);
}

/* One to eight edits of a corpus entry: bit flips, byte sets (with the boundary values), inserts,
 * deletes, a chunk copied from another entry, truncation. */
static size_t mutate(uint8_t *buf, size_t cap) {
  const input_t *base = &g_corpus[below(g_count)];
  size_t len = base->len;
  memcpy(buf, base->bytes, len);
  static const uint8_t interesting[] = {0x00, 0x01, 0x0f, 0x10, 0x20, 0x2d, 0x7f, 0x80, 0x81, 0xa0, 0xc2, 0xe2, 0xef, 0xfe, 0xff};
  size_t edits = 1 + below(8);
  for (size_t k = 0; k < edits; k++) {
    switch (below(6)) {
      case 0:
        if (len > 0) buf[below(len)] ^= (uint8_t)(1u << below(8));
        break;
      case 1:
        if (len > 0) buf[below(len)] = below(2) ? interesting[below(sizeof interesting)] : (uint8_t)next_u32();
        break;
      case 2:
        if (len < cap) {
          size_t at = below(len + 1);
          memmove(buf + at + 1, buf + at, len - at);
          buf[at] = (uint8_t)next_u32();
          len++;
        }
        break;
      case 3:
        if (len > 0) {
          size_t at = below(len);
          memmove(buf + at, buf + at + 1, len - at - 1);
          len--;
        }
        break;
      case 4: {
        const input_t *other = &g_corpus[below(g_count)];
        if (other->len == 0 || len == 0) break;
        size_t from = below(other->len), n = 1 + below(other->len - from), at = below(len);
        if (at + n > cap) n = cap - at;
        memcpy(buf + at, other->bytes + from, n);
        if (at + n > len) len = at + n;
        break;
      }
      default:
        len = below(len + 1);
        break;
    }
  }
  return len;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: %s <corpus dir> [-runs N] [-seed S] [-crash_dir D]\n", argv[0]);
    return 1;
  }
  unsigned long runs = 20000, seed = 0x51a7e;
  for (int i = 2; i + 1 < argc; i++) {
    if (strcmp(argv[i], "-runs") == 0) runs = strtoul(argv[i + 1], NULL, 0);
    if (strcmp(argv[i], "-seed") == 0) seed = strtoul(argv[i + 1], NULL, 0);
    if (strcmp(argv[i], "-crash_dir") == 0) g_crash_dir = argv[i + 1];
  }
  __sanitizer_set_death_callback(on_death);
  LLVMFuzzerInitialize(&argc, &argv);
  load(argv[1]);
  if (g_count == 0) {
    fprintf(stderr, "standalone: corpus %s is empty\n", argv[1]);
    return 1;
  }
  for (size_t i = 0; i < g_count; i++) {
    g_round = -(long)i - 1;
    run_one(g_corpus[i].bytes, g_corpus[i].len);
  }
  g_state = (uint32_t)seed;
  size_t cap = MAX_INPUT;
  uint8_t *buf = malloc(cap);
  if (buf == NULL) abort();
  for (unsigned long r = 0; r < runs; r++) {
    g_round = (long)r;
    size_t len = mutate(buf, cap);
    run_one(buf, len);
  }
  free(buf);
  printf("standalone: %zu corpus files, %lu mutations, seed %#lx\n", g_count, runs, seed);
  return 0;
}
