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
    sha256 "c635ff75bcd34c65056b5a3dedfbb0a5d985c742529a54a1a85f55432a7439e3"
  else
    url "https://github.com/matiinchauspe/crisol/releases/download/v#{version}/crisol-darwin-x64"
    sha256 "70cf4f77dc88eefe558b25f2c9d48d2f83062658936dc6d5a079d94c79e258e6"
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
