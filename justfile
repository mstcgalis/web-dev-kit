# list recipes
default:
    @just --list

# bun test — every command against test/project
check:
    bun test

# the node_modules hash after a bun.lock change
hash:
    nix build .#node-modules 2>&1 | grep 'got:' || echo "hash unchanged"
