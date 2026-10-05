{
  description = "web-dev-kit: shared checks and stack dev shells for web projects";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    # Only for playwright-driver: its version must equal the npm `playwright`
    # in package.json (1.63.0), or Linux browsers will not launch. 26.05 ships
    # 1.59.1; unstable had 1.63.0 on 2026-10-05.
    nixpkgs-browsers.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs, nixpkgs-browsers }:
    let
      systems = [ "aarch64-darwin" "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      src = nixpkgs.lib.fileset.toSource {
        root = ./.;
        fileset = nixpkgs.lib.fileset.unions [ ./bin ./lib ./package.json ./bun.lock ];
      };
    in {
      packages = forAll (pkgs: rec {
        # Fixed-output: bun fetches over the network, Nix pins the result by hash.
        # Bump the hash whenever bun.lock changes (build once with lib.fakeHash).
        node-modules = pkgs.stdenvNoCC.mkDerivation {
          pname = "web-dev-kit-node-modules";
          version = "0.2.0";
          inherit src;
          nativeBuildInputs = [ pkgs.bun ];
          dontConfigure = true;
          buildPhase = ''
            export HOME=$TMPDIR
            bun install --frozen-lockfile --production --ignore-scripts
          '';
          installPhase = "cp -r node_modules $out";
          dontFixup = true;
          outputHashMode = "recursive";
          outputHashAlgo = "sha256";
          outputHash = "sha256-1H/Z7HJje3vPxUBj6FZOgCjXQLllhAK3fHKJ+nSxRcM=";
        };
        wdk = pkgs.stdenvNoCC.mkDerivation {
          pname = "web-dev-kit";
          version = "0.2.0";
          inherit src;
          nativeBuildInputs = [ pkgs.makeWrapper ];
          dontBuild = true;
          installPhase = ''
            mkdir -p $out/share/web-dev-kit $out/bin
            cp -r bin lib package.json $out/share/web-dev-kit/
            ln -s ${node-modules} $out/share/web-dev-kit/node_modules
            makeWrapper ${pkgs.bun}/bin/bun $out/bin/wdk --add-flags $out/share/web-dev-kit/bin/wdk.js
          '';
        };
        default = wdk;
      });

      lib.devShell = { pkgs, stack ? "static", packages ? [ ] }:
        let
          system = pkgs.stdenv.hostPlatform.system;
          stacks = {
            static = [ ];
            # Same attribute as the vps PHP-FPM pool (services.phpfpm.pools.*.phpPackage).
            kirby = [ pkgs.php85 pkgs.php85Packages.composer ];
          };
        in pkgs.mkShell {
          packages = [ self.packages.${system}.wdk pkgs.just pkgs.bun ] ++ stacks.${stack} ++ packages;
          shellHook = pkgs.lib.optionalString pkgs.stdenv.isLinux ''
            export PLAYWRIGHT_BROWSERS_PATH=${nixpkgs-browsers.legacyPackages.${system}.playwright-driver.browsers}
            export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
          '';
        };

      devShells = forAll (pkgs: { default = self.lib.devShell { inherit pkgs; }; });
    };
}
