document.addEventListener('DOMContentLoaded', function () {
  var submitButton = document.getElementById('submit')
  if (!submitButton) return
  var template = document.getElementById('choice')
  var addP = document.createElement('p')
  var addButton = document.createElement('button')
  addP.appendChild(addButton)
  addButton.type = 'button'
  addButton.addEventListener('click', function (event) {
    event.preventDefault()
    event.stopPropagation()
    var clone = document.importNode(template.content, true)
    addButton.parentNode.insertBefore(clone, addButton)
  })
  addButton.appendChild(document.createTextNode('Add Option'))
  submitButton.parentNode.insertBefore(addP, submitButton)
})
