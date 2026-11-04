{
  description = "Better Profiles: a VS Code extension. Development shells.";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      # VS Code's own Electron binary is what the Extension Host tests run in, and it is Linux-only here.
      systems = [ "x86_64-linux" "aarch64-linux" ];

      forEachSystem = f: nixpkgs.lib.genAttrs systems (system: f (import nixpkgs {
        inherit system;
        # The tests run in the real VS Code build, which nixpkgs marks unfree.
        config.allowUnfree = true;
      }));
    in
    {
      devShells = forEachSystem (pkgs:
        let
          tools = [
            pkgs.nodejs_22 # the extension and its tests
            pkgs.vsce # `vsce package`, to build the .vsix
          ];

          # The tests need a VS Code to run in (.vscode-test.mjs reads BETTER_PROFILES_VSCODE). It is not put on
          # PATH, so it never shadows the `code` you already use. Set the variable yourself to use another build.
          useNixVscode = ''
            export BETTER_PROFILES_VSCODE="''${BETTER_PROFILES_VSCODE:-${pkgs.vscode}/lib/vscode/code}"
          '';
        in
        {
          # Editing, building, unit tests, and the Extension Host tests on a machine with a display.
          default = pkgs.mkShell {
            packages = tools;
            shellHook = useNixVscode + ''
              echo "Better Profiles dev shell: node $(node --version), VS Code for the tests: $BETTER_PROFILES_VSCODE"
              echo "  npm ci && npm run test:unit && npm test"
            '';
          };

          # The same, for a machine without a display (CI, a server, or a Wayland desktop you do not want windows on):
          #   nix develop .#headless -c xvfb-run -a npm test
          headless = pkgs.mkShell {
            packages = tools ++ [ pkgs.xvfb-run ];
            shellHook = useNixVscode + ''
              export BETTER_PROFILES_HEADLESS=1 # no GPU, X11, no sandbox: the flags Xvfb needs
              unset WAYLAND_DISPLAY # Electron must use the virtual X display
              echo "Better Profiles headless shell: run  xvfb-run -a npm test"
            '';
          };
        });
    };
}
