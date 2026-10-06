// The names a file exports, read from its own syntax. ESM export statements
// sit at the top level; CommonJS assignments to module.exports or exports can
// sit anywhere, so the whole tree is searched for those.

import { Node, SyntaxKind, type SourceFile } from "ts-morph";

/** What `module.exports = <value>` is recorded as when the value's own names can't all be read. */
const WHOLE_MODULE = "module.exports";

type Add = (name: string, at: Node) => void;

/** Every name a file exports, in source order, each once. */
export function exportedNames(source: SourceFile): string[] {
  const found: { name: string; at: number }[] = [];
  const add: Add = (name, at) => found.push({ name, at: at.getStart() });

  for (const statement of source.getStatements()) {
    if (Node.isExportDeclaration(statement)) {
      // `export * from` names nothing here; `export * as ns from` names ns.
      const namespace = statement.getNamespaceExport();
      if (namespace) add(namespace.getName(), statement);
      for (const specifier of statement.getNamedExports()) add(specifier.getAliasNode()?.getText() ?? specifier.getName(), specifier);
    } else if (Node.isExportAssignment(statement)) {
      // `export = x` is TypeScript's spelling of module.exports = x.
      if (statement.isExportEquals()) wholeModule(statement.getExpression(), add);
      else add("default", statement);
    } else if (Node.isVariableStatement(statement)) {
      if (!statement.hasExportKeyword()) continue;
      for (const declaration of statement.getDeclarations()) {
        const name = declaration.getNameNode();
        if (Node.isIdentifier(name)) add(name.getText(), name);
        // `export const { a, b: c } = x` exports a and c.
        else for (const element of name.getDescendantsOfKind(SyntaxKind.BindingElement)) {
          const bound = element.getNameNode();
          if (Node.isIdentifier(bound)) add(bound.getText(), bound);
        }
      }
    } else if (
      Node.isFunctionDeclaration(statement) ||
      Node.isClassDeclaration(statement) ||
      Node.isInterfaceDeclaration(statement) ||
      Node.isTypeAliasDeclaration(statement) ||
      Node.isEnumDeclaration(statement) ||
      Node.isModuleDeclaration(statement)
    ) {
      if (!statement.hasExportKeyword()) continue;
      if (statement.hasDefaultKeyword()) {
        add("default", statement);
        continue;
      }
      // `declare module "x"` is named by a string and exports nothing from this file.
      const name = statement.getNameNode();
      if (name && Node.isIdentifier(name)) add(name.getText(), name);
    }
  }

  for (const assignment of source.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (assignment.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;
    const target = assignment.getLeft();
    if (isModuleExports(target)) {
      wholeModule(assignment.getRight(), add);
      continue;
    }
    // module.exports.name = …, exports.name = …, and the ["name"] forms.
    if (Node.isPropertyAccessExpression(target) || Node.isElementAccessExpression(target)) {
      if (!isExportsObject(target.getExpression())) continue;
      const name = Node.isPropertyAccessExpression(target) ? target.getName() : literalText(target.getArgumentExpression());
      if (name !== null) add(name, target);
    }
  }

  // Object.defineProperty(exports, "name", …) is how compiled CommonJS writes
  // them. "__esModule" is the compiler's own marker, not something exported.
  for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getText() !== "Object.defineProperty") continue;
    const [object, key] = call.getArguments();
    if (!object || !isExportsObject(object)) continue;
    const name = literalText(key);
    if (name !== null && name !== "__esModule") add(name, call);
  }

  found.sort((a, b) => a.at - b.at);
  return [...new Set(found.map((f) => f.name))];
}

// `module.exports = { a, b }` exports a and b. Anything else, including an
// object with a spread or a computed key, is one value whose names aren't all
// written here, so it's recorded as that value rather than as a partial list.
function wholeModule(value: Node, add: Add): void {
  if (Node.isObjectLiteralExpression(value)) {
    const names: { name: string; at: Node }[] = [];
    for (const property of value.getProperties()) {
      if (Node.isSpreadAssignment(property)) return add(WHOLE_MODULE, value);
      const nameNode = property.getNameNode();
      const name = Node.isIdentifier(nameNode) ? nameNode.getText() : literalText(nameNode);
      if (name === null) return add(WHOLE_MODULE, value);
      names.push({ name, at: property });
    }
    for (const n of names) add(n.name, n.at);
    return;
  }
  add(WHOLE_MODULE, value);
}

function isModuleExports(node: Node): boolean {
  if (!Node.isPropertyAccessExpression(node) || node.getName() !== "exports") return false;
  const object = node.getExpression();
  return Node.isIdentifier(object) && object.getText() === "module";
}

function isExportsObject(node: Node): boolean {
  return isModuleExports(node) || (Node.isIdentifier(node) && node.getText() === "exports");
}

function literalText(node: Node | undefined): string | null {
  return node && (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) ? node.getLiteralValue() : null;
}
