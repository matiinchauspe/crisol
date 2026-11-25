# frozen_string_literal: true

# This repo is its own tap. The release workflow writes version and both sha256 here on main
# once the release publishes, so a tagged commit still carries the previous release's values.
class Crisol < Formula
  desc "Run one Task in a container, unattended, and get back exactly one branch"
  homepage "https://github.com/matiinchauspe/crisol"
  version "0.2.0"
  license "MIT"

  depends_on :macos

  if Hardware::CPU.arm?
    url "https://github.com/matiinchauspe/crisol/releases/download/v#{version}/crisol-darwin-arm64"
    sha256 "2336d3ee437357597bc1b1b1c2d8962a9c6fb73cefdf146e4fc1674d82567ae9"
  else
    url "https://github.com/matiinchauspe/crisol/releases/download/v#{version}/crisol-darwin-x64"
    sha256 "1c4f8a4697f2234a9e77bb7aef7956bbbf1fecc20f4d0c2e900e0246d8b3f3a0"
  end

  def install
    bin.install Dir["crisol-darwin-*"].first => "crisol"
  end

  def caveats
    <<~EOS
      Crisol needs a running Docker engine (OrbStack, Docker Desktop or Colima).
      Then: `crisol auth` once, and `crisol init` in each repo you run it on.
    EOS
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/crisol --version").strip
  end
end
