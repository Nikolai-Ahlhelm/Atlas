---
title: 📄 Page Design
description: Everything you need to know
roles: [Users]
owner: Atlas
version: "1.0"
position: 2
reviewDate: 2027-01-01
---

# The Basics 
  
```Markdown
# This is a H1 Header 
  
## This is a H2 Header 
  
### This is a H3 Header 
  
- Bullet
- Point

[This is an interal link](/home)
[This is an external link](https://github.com/Nikolai-Ahlhelm/Atlas)

Normal text is just written as normal text. 
Emojis can be used too 😀 
```


# This is a H1 Header 
  
## This is a H2 Header 
  
### This is a H3 Header 
  
- Bullet
- Point

[This is an interal link](/home)
[This is an external link](https://github.com/Nikolai-Ahlhelm/Atlas)


# Codeblocks 
  
Visualize your code with codeblocks! It's simple just sourrund your code like this:

````
```Python
# Create a sample collection
users = {'Hans': 'active', 'Éléonore': 'inactive', '景太郎': 'active'}

# Strategy:  Iterate over a copy
for user, status in users.copy().items():
    if status == 'inactive':
        del users[user]

# Strategy:  Create a new collection
active_users = {}
for user, status in users.items():
    if status == 'active':
        active_users[user] = status
```
````