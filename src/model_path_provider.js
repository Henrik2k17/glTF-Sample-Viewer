export function fillEnvironmentWithPaths(environmentNames, environmentsBasePath) {
    Object.keys(environmentNames).map(function (name, index) {
        const title = environmentNames[name];
        environmentNames[name] = {
            index: index,
            title: title,
            hdr_path: environmentsBasePath + name + ".hdr",
            jpg_path: environmentsBasePath + name + ".jpg",
            license_path: environmentsBasePath + name + ".hdr.license",
            base_path: environmentsBasePath
        };
    });
    return environmentNames;
}
