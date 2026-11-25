# frozen_string_literal: true

# This repo is its own tap. Once a release publishes, its workflow opens a pull request writing
# version and both sha256 here, so a tagged commit still carries the previous release's values.
class Crisol < Formula
  desc "Run one Task in a container, unattended, and get back exactly one branch"
  homepage "https://github.com/matiinchauspe/crisol"
  version "0.2.1"
  license "MIT"

  depends_on :macos

  if Hardware::CPU.arm?
    url "https://github.com/matiinchauspe/crisol/releases/download/v#{version}/crisol-darwin-arm64"
    sha256 "a23c7db2643cd68f3d058f8f199743221086ac7a1111fd0e851e89852b5b21f0"
  else
    url "https://github.com/matiinchauspe/crisol/releases/download/v#{version}/crisol-darwin-x64"
    sha256 "7b7665aa631b0317cc0a95bd96aba93d7a2ab365eddf17c1e8ad11b556a5dd2b"
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
