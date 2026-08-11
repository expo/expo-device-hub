const defaultFormatter = require("@changesets/cli/changelog").default;

const commitPrefix = /^(?:[0-9a-f]{7})(?:, [0-9a-f]{7})*: /i;

function formatWithoutGeneratedPrefix(summary) {
  const [firstLine, ...futureLines] = summary
    .split("\n")
    .map((line) => line.trimEnd());

  let result = `- ${firstLine}`;
  if (futureLines.length > 0) {
    result += `\n${futureLines.map((line) => `  ${line}`).join("\n")}`;
  }
  return result;
}

module.exports = {
  getReleaseLine(changeset, type, options) {
    if (commitPrefix.test(changeset.summary)) {
      return Promise.resolve(formatWithoutGeneratedPrefix(changeset.summary));
    }
    return defaultFormatter.getReleaseLine(changeset, type, options);
  },

  getDependencyReleaseLine(changesets, dependenciesUpdated, options) {
    return defaultFormatter.getDependencyReleaseLine(
      changesets,
      dependenciesUpdated,
      options,
    );
  },
};
