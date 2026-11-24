# frozen_string_literal: true

# This repo is its own tap. The release workflow writes version and both sha256 here on main
# once the release publishes, so a tagged commit still carries the previous release's values.
class Crisol < Formula
  desc "Run one Task in a container, unattended, and get back exactly one branch"
  homepage "https://github.com/matiinchauspe/crisol"
  version "0.1.0"
  license "MIT"

  depends_on :macos

  if Hardware::CPU.arm?
    url "https://github.com/matiinchauspe/crisol/releases/download/v#{version}/crisol-darwin-arm64"
    sha256 "REPLACE_WITH_SHA256_OF_crisol-darwin-arm64"
  else
    url "https://github.com/matiinchauspe/crisol/releases/download/v#{version}/crisol-darwin-x64"
    sha256 "REPLACE_WITH_SHA256_OF_crisol-darwin-x64"
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
