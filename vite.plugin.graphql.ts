/**
 * Vite plugin that transforms .gql / .graphql files into ES module string exports.
 * Import any .gql file and you get the raw GraphQL string — resolved at build time,
 * no filesystem reads at runtime.
 *
 * Usage:
 *   import CREATE_PRODUCT from "~/graphql/mutations/product.create.mutation.gql";
 */
export function graphqlLoader() {
  return {
    name: "vite-plugin-graphql-loader",
    transform(code: string, id: string) {
      if (/\.(gql|graphql)$/.test(id)) {
        return {
          code: `export default ${JSON.stringify(code)};`,
          map: null,
        };
      }
    },
  };
}
