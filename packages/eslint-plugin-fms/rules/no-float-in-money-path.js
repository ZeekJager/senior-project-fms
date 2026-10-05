module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "Prevent floats in money/fuel paths to avoid floating point math errors.",
    },
    messages: {
      noFloat: "Do not use parseFloat, Number, or division on money/fuel variables. Use the units.js module instead.",
    },
  },
  create(context) {
    // We get the filename in a cross-platform way
    const filename = context.getFilename ? context.getFilename() : context.filename;
    
    // The rule doesn't apply inside the units.js utility itself
    if (filename && filename.endsWith('units.js')) {
      return {};
    }

    const forbiddenNames = /^(cost|fuel|birr|cents|ml)/i;

    function isForbiddenVariable(name) {
      return name && forbiddenNames.test(name);
    }

    return {
      CallExpression(node) {
        // parseFloat(cost) or Number(cost)
        if (node.callee.type === "Identifier" && (node.callee.name === "parseFloat" || node.callee.name === "Number")) {
          const arg = node.arguments[0];
          if (arg && arg.type === "Identifier" && isForbiddenVariable(arg.name)) {
            context.report({ node, messageId: "noFloat" });
          }
        }
      },
      BinaryExpression(node) {
        // cost / 100
        if (node.operator === "/") {
          if ((node.left.type === "Identifier" && isForbiddenVariable(node.left.name)) ||
              (node.right.type === "Identifier" && isForbiddenVariable(node.right.name))) {
            context.report({ node, messageId: "noFloat" });
          }
        }
      },
      VariableDeclarator(node) {
        // const cost = x / y
        if (node.id.type === "Identifier" && isForbiddenVariable(node.id.name)) {
           if (node.init && node.init.type === "BinaryExpression" && node.init.operator === "/") {
             context.report({ node, messageId: "noFloat" });
           }
        }
      }
    };
  }
};
