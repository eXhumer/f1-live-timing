import { REST, Routes } from "discord.js";

export class CommandRegisterClient {
  rest: REST;

  constructor(token: string) {
    this.rest = new REST({ version: "10" }).setToken(token);
  }

  public register = async (clientId: string, commands: { name: string, description: string }[]) => {
    console.log("Started refreshing application (/) commands.");
    await this.rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log("Successfully reloaded application (/) commands.");
  }
}
