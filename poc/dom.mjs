// Provider/user content is always text, never parsed markup.
export function createElementFactory(document) {
  return (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
}
